package main

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 需求带图的后端：上传 / 读取 / 删除。

var (
	pngBytes  = append([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, bytes.Repeat([]byte{0x01}, 32)...)
	jpegBytes = append([]byte{0xff, 0xd8, 0xff, 0xe0}, bytes.Repeat([]byte{0x02}, 32)...)
	gifBytes  = append([]byte("GIF89a"), bytes.Repeat([]byte{0x03}, 32)...)
	webpBytes = append(append([]byte("RIFF"), []byte{0, 0, 0, 0}...), append([]byte("WEBP"), bytes.Repeat([]byte{0x04}, 32)...)...)
)

// newImageServer 起一个图片目录落在临时目录里的服务（project demo 用 roleChain）。
func newImageServer(t *testing.T) (*httptest.Server, Store, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := OpenStore("sqlite", filepath.Join(t.TempDir(), "chain.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	ts := httptest.NewServer(NewServer(store, FakeExecutor{}).WithUploadDir(dir).Handler())
	t.Cleanup(ts.Close)
	seedRoot(t, ts, store)
	p := Project{Key: "demo", Name: "Demo", Repo: "o/r", DefaultBranch: "main",
		Chains: []Chain{roleChain()}, CreatedAt: time.Now()}
	if err := store.SaveProject(&p); err != nil {
		t.Fatal(err)
	}
	return ts, store, dir
}

// filePart 是一次上传里的一份文件：名字、内容、以及客户端自称的类型。
type filePart struct {
	name        string
	data        []byte
	contentType string
}

// uploadRaw 发一次 multipart 上传（who 为空=匿名），返回状态码与响应体。
func uploadRaw(t *testing.T, ts *httptest.Server, who, id string, files []filePart) (int, []byte) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for _, f := range files {
		h := make(map[string][]string)
		h["Content-Disposition"] = []string{`form-data; name="files"; filename="` + f.name + `"`}
		ct := f.contentType
		if ct == "" {
			ct = "application/octet-stream"
		}
		h["Content-Type"] = []string{ct}
		part, err := w.CreatePart(h)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(f.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest("POST", ts.URL+"/api/requirements/"+id+"/images", &buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	cl := http.DefaultClient
	if who != "" {
		cl = clientOf(t, ts, who)
	}
	res, err := cl.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out := new(bytes.Buffer)
	if _, err := out.ReadFrom(res.Body); err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, out.Bytes()
}

// uploadOK 上传一组文件并要求 200，解出更新后的需求。
func uploadOK(t *testing.T, ts *httptest.Server, id string, files []filePart) *Requirement {
	t.Helper()
	code, raw := uploadRaw(t, ts, rootUser, id, files)
	if code != 200 {
		t.Fatalf("上传期望 200，实际 %d：%s", code, raw)
	}
	var req Requirement
	if err := json.Unmarshal(raw, &req); err != nil {
		t.Fatal(err)
	}
	return &req
}

// countFiles 数落盘目录里真正写下去的文件（目录不存在算 0）。
func countFiles(t *testing.T, dir string) int {
	t.Helper()
	n := 0
	_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err == nil && info != nil && !info.IsDir() {
			n++
		}
		return nil
	})
	return n
}

// imagePath 是落盘路径：上传回来的相对路径去掉 /api/requirements/<id>/images/ 前缀就是文件名。
func imageName(t *testing.T, rel string) string {
	t.Helper()
	i := strings.LastIndex(rel, "/")
	if i < 0 || i == len(rel)-1 {
		t.Fatalf("图片相对路径形状不对：%s", rel)
	}
	return rel[i+1:]
}

// 一张图：200、Images 里多一条、磁盘上真有这份字节。
func TestUploadSingleImage(t *testing.T) {
	ts, _, dir := newImageServer(t)
	req := submit(t, ts, "带图的缺陷")
	got := uploadOK(t, ts, req.ID, []filePart{{name: "shot.png", data: pngBytes, contentType: "image/png"}})
	if len(got.Images) != 1 {
		t.Fatalf("Images 应有 1 条，实际 %d：%v", len(got.Images), got.Images)
	}
	want := "/api/requirements/" + req.ID + "/images/"
	if !strings.HasPrefix(got.Images[0], want) || !strings.HasSuffix(got.Images[0], ".png") {
		t.Fatalf("相对路径形状不对：%s", got.Images[0])
	}
	onDisk := filepath.Join(dir, req.ID, imageName(t, got.Images[0]))
	data, err := os.ReadFile(onDisk)
	if err != nil {
		t.Fatalf("磁盘上应当有这张图：%v", err)
	}
	if !bytes.Equal(data, pngBytes) {
		t.Fatalf("落盘字节与原文件不一致：%d vs %d", len(data), len(pngBytes))
	}
}

// 三张图（png / jpeg / gif）：一次上传三条都进去，扩展名按文件头给而不是按客户端文件名。
func TestUploadThreeImages(t *testing.T) {
	ts, _, dir := newImageServer(t)
	req := submit(t, ts, "三张图")
	got := uploadOK(t, ts, req.ID, []filePart{
		{name: "a.png", data: pngBytes},
		{name: "b.jpeg", data: jpegBytes},
		{name: "c.gif", data: gifBytes},
	})
	if len(got.Images) != 3 {
		t.Fatalf("Images 应有 3 条，实际 %d：%v", len(got.Images), got.Images)
	}
	if n := countFiles(t, filepath.Join(dir, req.ID)); n != 3 {
		t.Fatalf("磁盘上应有 3 个文件，实际 %d", n)
	}
	exts := map[string]bool{}
	for _, rel := range got.Images {
		exts[filepath.Ext(rel)] = true
	}
	for _, ext := range []string{".png", ".jpg", ".gif"} {
		if !exts[ext] {
			t.Fatalf("扩展名应当按文件头给（缺 %s）：%v", ext, got.Images)
		}
	}
}

// 伪装成 png 的文本：400，且磁盘上一个字节都不留（先全校验再落盘）。
func TestUploadRejectsFakeImageWithoutWriting(t *testing.T) {
	ts, _, dir := newImageServer(t)
	req := submit(t, ts, "伪装文件")
	code, raw := uploadRaw(t, ts, rootUser, req.ID, []filePart{
		{name: "fine.png", data: pngBytes, contentType: "image/png"},
		{name: "evil.png", data: []byte("这其实是一段文本"), contentType: "image/png"},
	})
	if code != 400 {
		t.Fatalf("伪装成 png 的文本应 400，实际 %d：%s", code, raw)
	}
	if !strings.Contains(string(raw), "不是支持的格式") {
		t.Fatalf("400 文案应说明格式不支持，实际 %s", raw)
	}
	if n := countFiles(t, dir); n != 0 {
		t.Fatalf("整批被拒时不该落盘任何文件，实际 %d 个", n)
	}
	again := fetchReq(t, ts, req.ID)
	if len(again.Images) != 0 {
		t.Fatalf("被拒之后 Images 不该变，实际 %v", again.Images)
	}
}

// 6 个文件：400（单次上限 5 个），零落盘。
func TestUploadRejectsTooManyFiles(t *testing.T) {
	ts, _, dir := newImageServer(t)
	req := submit(t, ts, "六张图")
	files := make([]filePart, 0, 6)
	for i := 0; i < 6; i++ {
		files = append(files, filePart{name: "x.png", data: pngBytes})
	}
	code, raw := uploadRaw(t, ts, rootUser, req.ID, files)
	if code != 400 {
		t.Fatalf("6 个文件应 400，实际 %d：%s", code, raw)
	}
	if !strings.Contains(string(raw), "一次最多传 5 张") {
		t.Fatalf("400 文案应点名上限，实际 %s", raw)
	}
	if n := countFiles(t, dir); n != 0 {
		t.Fatalf("超量时不该落盘，实际 %d 个", n)
	}
}

// 6MB 的 png：400（单文件上限 5MB），零落盘。
func TestUploadRejectsOversizeFile(t *testing.T) {
	ts, _, dir := newImageServer(t)
	req := submit(t, ts, "大图")
	big := append(append([]byte{}, pngBytes...), bytes.Repeat([]byte{0x05}, 6<<20)...)
	code, raw := uploadRaw(t, ts, rootUser, req.ID, []filePart{{name: "big.png", data: big}})
	if code != 400 {
		t.Fatalf("6MB 的图应 400，实际 %d：%s", code, raw)
	}
	if !strings.Contains(string(raw), "超过 5MB") {
		t.Fatalf("400 文案应点名 5MB 上限，实际 %s", raw)
	}
	if n := countFiles(t, dir); n != 0 {
		t.Fatalf("超限时不该落盘，实际 %d 个", n)
	}
}

// 读回来必须与原文件逐字节一致，并带上正确的 Content-Type 与 Content-Length。
func TestReadImageRoundTrip(t *testing.T) {
	ts, _, _ := newImageServer(t)
	req := submit(t, ts, "读图")
	got := uploadOK(t, ts, req.ID, []filePart{{name: "a.png", data: pngBytes}})
	code, raw := exchange(t, ts, clientOf(t, ts, rootUser), "GET", got.Images[0], nil)
	if code != 200 {
		t.Fatalf("读图期望 200，实际 %d：%s", code, raw)
	}
	if !bytes.Equal(raw, pngBytes) {
		t.Fatalf("读回来的字节与原文件不一致：%d vs %d", len(raw), len(pngBytes))
	}
}

// 读图的响应头：Content-Type 按落盘扩展名给，Content-Length 等于字节数。
func TestReadImageHeaders(t *testing.T) {
	ts, _, _ := newImageServer(t)
	req := submit(t, ts, "看头")
	got := uploadOK(t, ts, req.ID, []filePart{{name: "a.png", data: pngBytes}})
	res, err := clientOf(t, ts, rootUser).Get(ts.URL + got.Images[0])
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("读图期望 200，实际 %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("Content-Type 应是 image/png，实际 %q", ct)
	}
	if cl := res.Header.Get("Content-Length"); cl != strconv.Itoa(len(pngBytes)) {
		t.Fatalf("Content-Length 应是 %d，实际 %q", len(pngBytes), cl)
	}
}

// 两种越界都要 404：路径里的 ".."，以及 URL 编码过的 %2e%2e。
func TestReadImagePathTraversalIs404(t *testing.T) {
	ts, _, _ := newImageServer(t)
	req := submit(t, ts, "越界")
	uploadOK(t, ts, req.ID, []filePart{{name: "a.png", data: pngBytes}})
	for _, p := range []string{
		"/api/requirements/" + req.ID + "/images/..%2f..%2fchain.db",
		"/api/requirements/" + req.ID + "/images/%2e%2e",
		"/api/requirements/" + req.ID + "/images/..",
	} {
		code, raw := exchange(t, ts, clientOf(t, ts, rootUser), "GET", p, nil)
		if code != 404 {
			t.Fatalf("越界路径 %s 应 404，实际 %d：%s", p, code, raw)
		}
	}
}

// 删除：文件和 Images 一起没了；再删一次 404。
func TestDeleteImage(t *testing.T) {
	ts, _, dir := newImageServer(t)
	req := submit(t, ts, "删图")
	got := uploadOK(t, ts, req.ID, []filePart{{name: "a.png", data: pngBytes}})
	name := imageName(t, got.Images[0])
	if n := countFiles(t, filepath.Join(dir, req.ID)); n != 1 {
		t.Fatalf("删除前应有 1 个文件，实际 %d", n)
	}
	if raw := callRaw(t, ts, rootUser, "DELETE", got.Images[0], nil, 200); !strings.Contains(raw, `"images":[]`) {
		t.Fatalf("删完之后需求里不该再有这张图，实际 %s", raw)
	}
	if _, err := os.Stat(filepath.Join(dir, req.ID, name)); !os.IsNotExist(err) {
		t.Fatalf("删完之后磁盘上不该还有文件：%v", err)
	}
	callRaw(t, ts, rootUser, "DELETE", got.Images[0], nil, 404)
}

// 别的需求的图按不存在处理：拿 B 的 id 去读 A 的图，404。
func TestImageOfAnotherRequirementIs404(t *testing.T) {
	ts, _, _ := newImageServer(t)
	a := submit(t, ts, "带图的需求")
	b := submit(t, ts, "没图的需求")
	got := uploadOK(t, ts, a.ID, []filePart{{name: "a.png", data: pngBytes}})
	name := imageName(t, got.Images[0])
	code, raw := exchange(t, ts, clientOf(t, ts, rootUser), "GET", "/api/requirements/"+b.ID+"/images/"+name, nil)
	if code != 404 {
		t.Fatalf("不属于这条需求的图应 404，实际 %d：%s", code, raw)
	}
}

// 未登录：上传与读图都 401。
func TestImagesNeedLogin(t *testing.T) {
	ts, _, _ := newImageServer(t)
	req := submit(t, ts, "登录才能看图")
	got := uploadOK(t, ts, req.ID, []filePart{{name: "a.png", data: pngBytes}})
	if code, raw := uploadRaw(t, ts, "", req.ID, []filePart{{name: "b.png", data: pngBytes}}); code != 401 {
		t.Fatalf("未登录上传应 401，实际 %d：%s", code, raw)
	}
	code, raw := exchange(t, ts, nil, "GET", got.Images[0], nil)
	if code != 401 || !strings.Contains(string(raw), needLoginText) {
		t.Fatalf("未登录读图应 401 needLoginText，实际 %d：%s", code, raw)
	}
}
