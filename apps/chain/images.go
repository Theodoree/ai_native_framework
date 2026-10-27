package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// images.go —— 需求带图：上传、读取、删除。
//
// 为什么要有这一个文件：需求正文是纯文本，评审要看的截图 / 设计稿没处放。
// 三条约定值得写下来：
//   - 类型按**文件头**判，不信 Content-Type 也不信扩展名：客户端给的这两样都是可以被随便写的，
//     信它们等于把「上传任意文件」的口子开着；
//   - **先全校验、再落盘**：一批里有任何一个不合规就整批 400，磁盘上一个字节都不留——
//     否则一次失败的上传会留下半批孤儿文件，还得人来清；
//   - 文件名只认 [A-Za-z0-9._-]，读取与删除还要问「这张图在不在这条需求的 images 里」：
//     目录穿越与「顺着 id 猜别人的图」都在这一道挡掉。

const (
	maxImageFiles = 5
	maxImageBytes = 5 << 20 // 5MB
	// defaultUploadDir 与服务端的 -uploads 默认值保持一致：测试与 main 都不传时也有地方落盘。
	defaultUploadDir = "data/uploads"
)

// imageTypes 是唯一一张「文件头 → 内容类型 + 扩展名」的表。加一种图片只改这里。
var imageTypes = []struct {
	contentType string
	ext         string
	magic       []byte
	// offset 是 magic 在文件里的位置：WebP 是 RIFF????WEBP，签名在第 8 字节。
	offset int
}{
	{contentType: "image/png", ext: ".png", magic: []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}},
	{contentType: "image/jpeg", ext: ".jpg", magic: []byte{0xff, 0xd8, 0xff}},
	{contentType: "image/gif", ext: ".gif", magic: []byte("GIF87a")},
	{contentType: "image/gif", ext: ".gif", magic: []byte("GIF89a")},
	{contentType: "image/webp", ext: ".webp", magic: []byte("WEBP"), offset: 8},
}

// sniffImage 只认文件头：返回内容类型与扩展名。
func sniffImage(head []byte) (string, string, bool) {
	for _, t := range imageTypes {
		if t.offset > 0 {
			// WebP 要先看 RIFF 再跳到第 8 字节看 WEBP，两段都中才算。
			if len(head) < t.offset+4 || !bytes.Equal(head[:4], []byte("RIFF")) {
				continue
			}
			if bytes.Equal(head[t.offset:t.offset+4], t.magic) {
				return t.contentType, t.ext, true
			}
			continue
		}
		if bytes.HasPrefix(head, t.magic) {
			return t.contentType, t.ext, true
		}
	}
	return "", "", false
}

// uploadDir 是这台服务落盘的地方：-uploads / WithUploadDir 决定，没配就落回默认值。
func (s *Server) uploadDir() string {
	if s.uploads != "" {
		return s.uploads
	}
	return defaultUploadDir
}

// imageRel 是存进 Requirement.Images 的相对路径，也是前端 <img src>。只在这里拼。
func imageRel(reqID, name string) string {
	return "/api/requirements/" + reqID + "/images/" + name
}

// imageNameOK 是路径守卫：只允许 [A-Za-z0-9._-]，且不许出现 ".."。
// 越界一律当「没有这张图片」（404），不告诉对方是路径非法——那等于替人试错。
func imageNameOK(name string) bool {
	if name == "" || name == "." || name == ".." || strings.Contains(name, "..") {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.', r == '_', r == '-':
		default:
			return false
		}
	}
	return true
}

// hasDotDotSegment 说路径里有没有 ".." 段（URL 解码之后看，所以 %2e%2e 也算）。
func hasDotDotSegment(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

// inImages 说这张图是不是这条需求自己的：不是就当不存在，别让人顺着 id 猜别人的图。
func inImages(req *Requirement, name string) bool {
	want := imageRel(req.ID, name)
	for _, img := range req.Images {
		if img == want {
			return true
		}
	}
	return false
}

// pendingImage 是「校验通过、还没落盘」的一张图。
type pendingImage struct {
	name string
	data []byte
	ext  string
}

// uploadRequirementImages 收一批图片：全部校验通过之后才写盘。
func (s *Server) uploadRequirementImages(c *gin.Context) {
	req, err := s.store.Requirement(c.Param("id"))
	if err != nil {
		fail(c, 404, err.Error())
		return
	}
	// 传图是新写：得是这个项目的人，且文案说的是「改不了这条需求」。
	if _, ok := s.requireMember(c, req.ProjectKey, actionChangeRequirement); !ok {
		return
	}
	form, err := c.MultipartForm()
	if err != nil {
		fail(c, 400, "请求不是合法的 multipart/form-data："+err.Error())
		return
	}
	files := form.File["files"]
	if len(files) == 0 {
		fail(c, 400, "没有收到文件：字段名是 files")
		return
	}
	if len(files) > maxImageFiles {
		fail(c, 400, fmt.Sprintf("一次最多传 %d 张图片，这次 %d 张", maxImageFiles, len(files)))
		return
	}
	// 第一轮只读与校验，什么都不写。
	pending := make([]pendingImage, 0, len(files))
	for _, fh := range files {
		if fh.Size > maxImageBytes {
			fail(c, 400, fmt.Sprintf("图片 %s 超过 %dMB", fh.Filename, maxImageBytes>>20))
			return
		}
		f, err := fh.Open()
		if err != nil {
			fail(c, 400, "读不了上传的文件："+fh.Filename)
			return
		}
		data, err := io.ReadAll(io.LimitReader(f, maxImageBytes+1))
		f.Close()
		if err != nil {
			fail(c, 400, "读不了上传的文件："+fh.Filename)
			return
		}
		// LimitReader 兜一道：声明的 Size 与真正收到的字节可能不一致。
		if len(data) > maxImageBytes {
			fail(c, 400, fmt.Sprintf("图片 %s 超过 %dMB", fh.Filename, maxImageBytes>>20))
			return
		}
		_, ext, ok := sniffImage(data)
		if !ok {
			fail(c, 400, fmt.Sprintf("图片 %s 不是支持的格式（只收 png / jpeg / webp / gif，按文件头判）", fh.Filename))
			return
		}
		pending = append(pending, pendingImage{name: fh.Filename, data: data, ext: ext})
	}
	// 第二轮才写：目录按需求分，文件名随机（原始文件名不进磁盘，省得跟路径守卫打架）。
	dir := filepath.Join(s.uploadDir(), req.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fail(c, 500, "建图片目录失败："+err.Error())
		return
	}
	written := make([]string, 0, len(pending))
	for _, img := range pending {
		stem, err := randomToken("", 16)
		if err != nil {
			removeImages(dir, written)
			fail(c, 500, "生成图片名失败："+err.Error())
			return
		}
		name := stem + img.ext
		if err := os.WriteFile(filepath.Join(dir, name), img.data, 0o644); err != nil {
			removeImages(dir, written)
			fail(c, 500, "写图片失败："+err.Error())
			return
		}
		written = append(written, name)
		req.Images = append(req.Images, imageRel(req.ID, name))
	}
	req.Rev++
	if err := s.store.SaveRequirement(req); err != nil {
		removeImages(dir, written)
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, req)
}

// removeImages 是写盘失败时的回滚：已经把字节留在磁盘上的那些删掉，别留孤儿。
func removeImages(dir string, names []string) {
	for _, n := range names {
		_ = os.Remove(filepath.Join(dir, n))
	}
}

// requirementImage 读一张图。Content-Type 按落盘时的扩展名给，Content-Length 显式写死。
func (s *Server) requirementImage(c *gin.Context) {
	name := c.Param("name")
	if !imageNameOK(name) {
		fail(c, 404, "没有这张图片")
		return
	}
	req, err := s.store.Requirement(c.Param("id"))
	if err != nil {
		fail(c, 404, err.Error())
		return
	}
	if _, ok := s.requireMember(c, req.ProjectKey, actionViewRequirement); !ok {
		return
	}
	if !inImages(req, name) {
		fail(c, 404, "没有这张图片")
		return
	}
	data, err := os.ReadFile(filepath.Join(s.uploadDir(), req.ID, name))
	if err != nil {
		fail(c, 404, "没有这张图片")
		return
	}
	ctype := mime.TypeByExtension(filepath.Ext(name))
	if ctype == "" {
		ctype = http.DetectContentType(data)
	}
	c.Header("Content-Length", strconv.Itoa(len(data)))
	c.Data(200, ctype, data)
}

// deleteRequirementImage 删一张图：先删文件再从 Images 里摘掉，两处都不留痕迹。
func (s *Server) deleteRequirementImage(c *gin.Context) {
	name := c.Param("name")
	if !imageNameOK(name) {
		fail(c, 404, "没有这张图片")
		return
	}
	req, err := s.store.Requirement(c.Param("id"))
	if err != nil {
		fail(c, 404, err.Error())
		return
	}
	// 删图是改写这条需求（Images 里要摘一条），所以同上传一样按「改不了这条需求」拒。
	if _, ok := s.requireMember(c, req.ProjectKey, actionChangeRequirement); !ok {
		return
	}
	if !inImages(req, name) {
		fail(c, 404, "没有这张图片")
		return
	}
	if err := os.Remove(filepath.Join(s.uploadDir(), req.ID, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
		fail(c, 500, "删图片失败："+err.Error())
		return
	}
	want := imageRel(req.ID, name)
	kept := make([]string, 0, len(req.Images))
	for _, img := range req.Images {
		if img != want {
			kept = append(kept, img)
		}
	}
	req.Images = kept
	req.Rev++
	if err := s.store.SaveRequirement(req); err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, req)
}
