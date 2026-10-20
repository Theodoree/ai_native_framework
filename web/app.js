// 页面只经 JSON API 说话，不直接读文件。
const $ = (id) => document.getElementById(id);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ message: "响应不是 JSON" }));
  if (!res.ok) throw Object.assign(new Error(data.message), data);
  return data;
}

function render(board) {
  $("flow").textContent = "default_flow = " + (board.config.defaultFlow ?? "(未声明)");
  const terminal = new Set(board.config.states.filter((s) => s.terminal).map((s) => s.name));
  const box = $("board");
  if (!board.items.length) {
    box.textContent = "还没有需求。提一条试试。";
    return;
  }
  box.innerHTML = "";
  for (const item of board.items) {
    const card = document.createElement("article");
    card.className = "card";
    const head = document.createElement("div");
    head.className = "card-head";
    head.innerHTML =
      "<strong>" + item.id + "</strong> " +
      "<span class='state " + (terminal.has(item.state) ? "terminal" : "") + "'>" +
      (item.state ?? "none") +
      "</span>";
    const title = document.createElement("p");
    title.className = "card-title";
    title.textContent = item.title;
    const history = document.createElement("ol");
    history.className = "history";
    for (const event of item.history) {
      const li = document.createElement("li");
      li.textContent =
        event.at.slice(11, 19) + "  " + (event.from ?? "-") + " → " + event.to +
        "  by " + event.by + (event.comment ? "  · " + event.comment : "");
      history.append(li);
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    for (const to of ["rejected", "needs-info", "cancelled"]) {
      if (terminal.has(item.state) && to !== "cancelled") continue;
      const button = document.createElement("button");
      button.textContent = to;
      button.onclick = async () => {
        const comment = prompt("说明（转换要求必填）");
        if (comment === null) return;
        try {
          await api("POST", "/api/verdict", { id: item.id, to, actor_role: "owner", comment });
          await refresh();
        } catch (error) {
          alert(error.kind + " " + error.code + "\n" + error.message);
        }
      };
      actions.append(button);
    }
    card.append(head, title, history, actions);
    box.append(card);
  }
}

async function refresh() {
  render(await api("GET", "/api/board"));
}

$("submit").onclick = async () => {
  try {
    const created = await api("POST", "/api/item", {
      title: $("title").value,
      body: $("body").value,
    });
    $("submit-msg").textContent = created.id + " 已落到 " + created.to;
    $("title").value = "";
    $("body").value = "";
    await refresh();
  } catch (error) {
    $("submit-msg").textContent = error.kind + " " + error.code + "：" + error.message;
  }
};

$("verify").onclick = async () => {
  $("evidence").textContent = "运行中…";
  try {
    const result = await api("POST", "/api/verify", {});
    $("evidence").textContent = "exit " + result.exitCode + "\n\n" + result.output;
  } catch (error) {
    $("evidence").textContent = error.message;
  }
};

$("save-config").onclick = async () => {
  try {
    await api("PUT", "/api/config", { text: $("config").value });
    $("config-msg").textContent = "已保存，配置自检通过";
    await refresh();
  } catch (error) {
    $("config-msg").textContent = error.kind + " " + error.code + "：" + error.message;
  }
};

(async () => {
  $("config").value = (await api("GET", "/api/config")).text;
  await refresh();
})();
