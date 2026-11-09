/**
 * dsh-plugin-sessiongraph-panel · 浏览器端入口：设置页「会话检索」tab
 *
 * 为什么单独一个文件：本包只有客户端半侧，宿主负责把客户端模块下发给浏览器；所以这里走
 * CJS factory 包装，靠宿主注入的 require 取 react，不引任何 npm 包（没有构建步骤、也没有
 * import 语句）。
 *
 * 这个 tab 管两件互不相干的事：
 *
 * 1. 在 `sessiongraph` / `kernel` / `both` 之间切换「哪些会话检索工具对模型可见」——存进
 *    `panel.json` 后由宿主侧立刻改工具表。
 * 2. 开关「是否把 Codex 的历史会话也纳入索引」——同一个文件里的 `codexSync`，由**索引器**
 *    在下次运行时读取（本包不持有索引器配置，所以这里只写文件、只负责显示）。
 *
 * 数据全走同源 `/dsh-plugin-sessiongraph/api/tools`，无 token、无轮询——值只有用户点「保存」
 * 时才会变。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-sessiongraph-panel",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    /** 免 JSX 写组件（产物风格同官方插件） */
    const h = React.createElement;

    /** 宿主侧路由前缀；改这里要同步改 packages/tool/src/panel.ts */
    const API = "/dsh-plugin-sessiongraph/api";
    const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

    /** 宿主主题变量优先，取不到就退中性色 */
    const C = {
      primary: "var(--dsw-alias-label-primary, #1f2328)",
      secondary: "var(--dsw-alias-label-secondary, #6e7781)",
      tertiary: "var(--dsw-alias-label-tertiary, #8c959f)",
      border: "var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))",
      bg: "var(--dsw-alias-bg-l1, rgba(0, 0, 0, 0.03))",
      danger: "var(--dsw-alias-state-error-primary, #d9534f)",
      ok: "var(--dsw-alias-state-success-primary, #2e7d32)",
    };

    const BTN = {
      font: "inherit",
      fontSize: 12,
      lineHeight: "20px",
      padding: "2px 10px",
      borderRadius: 4,
      border: "1px solid " + C.border,
      background: "transparent",
      color: C.primary,
      cursor: "pointer",
      whiteSpace: "nowrap",
    };

    const S = {
      root: {
        padding: "16px 20px",
        fontSize: "var(--dsh-content-font-size, 13px)",
        lineHeight: 1.5,
        color: C.primary,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      },
      block: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 },
      headRow: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
      h1: { margin: 0, fontSize: 14, fontWeight: 600, lineHeight: 1.5, whiteSpace: "nowrap" },
      hint: { color: C.tertiary, fontSize: 12 },
      row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      checkRow: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer" },
      label: { color: C.secondary, fontSize: 12, whiteSpace: "nowrap" },
      select: {
        boxSizing: "border-box",
        minWidth: 220,
        padding: "4px 8px",
        border: "1px solid " + C.border,
        borderRadius: 4,
        background: C.bg,
        color: C.primary,
        font: "inherit",
        fontSize: 12,
        lineHeight: "20px",
        outline: "none",
      },
      btn: BTN,
      btnOff: { ...BTN, color: C.tertiary, cursor: "default" },
      okText: { color: C.ok, fontSize: 12, whiteSpace: "pre-wrap" },
      danger: { color: C.danger, fontSize: 12, whiteSpace: "pre-wrap" },
      muted: { color: C.tertiary, fontSize: 12 },
      mono: {
        fontFamily: MONO,
        fontSize: 12,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      options: { display: "flex", flexDirection: "column", gap: 4, margin: 0, padding: 0 },
      option: { color: C.secondary, fontSize: 12, lineHeight: 1.6 },
    };

    /**
     * 三个选项的说明。值是契约的一部分（宿主侧的 ToolSet 联合类型），文案只是给人看的：
     * 每个选项后面那句话回答的是「模型会因此少看到什么」，而不是复述名字。
     */
    const OPTIONS = [
      {
        value: "sessiongraph",
        label: "sessiongraph（推荐）",
        note: "隐藏内核的 5 个会话工具，只留 sessiongraph：答案来自预建索引，更快也更完整。",
      },
      {
        value: "kernel",
        label: "kernel",
        note: "隐藏本插件的 sessiongraph，只留宿主自带的 session_* 工具。",
      },
      {
        value: "both",
        label: "both",
        note: "两套都暴露。模型可能同一件事查两遍，也更占上下文。",
      },
    ];

    /**
     * 统一 fetch：把网络错误、非 2xx、以及 200 里 ok:false 都收敛成 { ok, message }。
     * 组件层面只读 ok/message，任何异常都不会冒成渲染错误。
     */
    async function call(url, init) {
      try {
        const res = await fetch(url, init);
        let body = null;
        try {
          body = await res.json();
        } catch (err) {
          body = null; // 非 JSON 也不该吞掉状态码，下面按 HTTP 报
        }
        if (!res.ok || (body && body.ok === false)) {
          return { ok: false, message: (body && body.message) || "HTTP " + res.status };
        }
        return { ok: true, data: body };
      } catch (err) {
        return { ok: false, message: "请求失败：" + (err && err.message ? err.message : err) };
      }
    }

    /** 宿主返回的 toolSet 只认这三个值；其它一律当作还没读到 */
    function knownToolSet(value) {
      return value === "sessiongraph" || value === "kernel" || value === "both" ? value : null;
    }

    /** 一行「检测到什么」的说明：没检测到比检测到更值得说，因为它意味着选了也不生效 */
    function availabilityText(available) {
      if (!available) return null;
      const kernel = Array.isArray(available.kernel) ? available.kernel : [];
      const parts = [];
      parts.push("内核会话工具：" + (kernel.length > 0 ? kernel.join("、") : "未检测到"));
      parts.push("sessiongraph：" + (available.sessiongraph === false ? "未检测到" : "已注册"));
      return parts.join(" ｜ ");
    }

    function SessiongraphSection() {
      const [toolSet, setToolSet] = React.useState(null);
      const [draft, setDraft] = React.useState("sessiongraph");
      /** 已保存的 Codex 开关；null 表示还没读到 */
      const [codex, setCodex] = React.useState(null);
      const [codexDraft, setCodexDraft] = React.useState(false);
      const [available, setAvailable] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      /** null | "load" | "save"：同时只跑一个请求 */
      const [busy, setBusy] = React.useState(null);
      /** 是否成功读过一次；用来区分「还没读」和「读到了但值是空的」 */
      const [loaded, setLoaded] = React.useState(false);

      // 打开就自动读一次当前值。设置页是用户主动打开的地方，一次同源 GET 的代价可以忽略。
      React.useEffect(function () {
        load();
        // 只在挂载时跑：之后由「保存」按钮驱动
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      /** 所有错误都走 state，不 throw —— 一个 tab 不该把设置页打白 */
      async function load() {
        setBusy("load");
        const result = await call(API + "/tools");
        setBusy(null);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        const data = result.data || {};
        setError(null);
        setAvailable(data.available || null);
        const current = knownToolSet(data.toolSet) || "sessiongraph";
        setToolSet(current);
        setDraft(current);
        // 宿主没给这个字段就当作「跟随插件默认」——索引器的默认是开，所以缺省按 true。
        // 反过来（缺省 false）会让一次只改工具集的保存顺手把 Codex 关掉，那是个静默的数据损失。
        const codexNow = data.codexSync !== false;
        setCodex(codexNow);
        setCodexDraft(codexNow);
        setLoaded(true);
      }

      /**
       * 落盘一次选择。
       *
       * 两个控件共用它：下拉必须显式点「保存」（选择后确认是下拉的语义），而开关是布尔量，
       * 点一下就该生效 —— 一个需要再按一次按钮的开关，用户不会去按第二下。
       *
       * @param nextToolSet 要保存的工具集
       * @param nextCodex 要保存的 Codex 开关
       * @param revertOnFailure 失败时把开关拨回去的值；不给就不回滚
       */
      async function persist(nextToolSet, nextCodex, revertOnFailure) {
        if (busy !== null) return;
        setBusy("save");
        setError(null);
        setNotice(null);
        const result = await call(API + "/tools", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ toolSet: nextToolSet, codexSync: nextCodex }),
        });
        setBusy(null);
        if (!result.ok) {
          setError(result.message);
          if (revertOnFailure !== undefined) setCodexDraft(revertOnFailure);
          return;
        }
        const data = result.data || {};
        const saved = knownToolSet(data.toolSet) || nextToolSet;
        const savedCodex = data.codexSync === true;
        setToolSet(saved);
        setDraft(saved);
        setCodex(savedCodex);
        setCodexDraft(savedCodex);
        if (data.available) setAvailable(data.available);
        setNotice(
          "已保存：工具集 " + saved + "；Codex 历史" + (savedCodex ? "纳入索引" : "不纳入索引") + "。"
            + "工具集对之后创建的会话立即生效；Codex 开关在下次索引运行时生效（下一次自动刷新或手动建索引）。",
        );
      }

      /** 下拉的「保存」：把两个当前值一起写下去。 */
      function onSave() {
        return persist(draft, codexDraft);
      }

      const dirty = loaded && (draft !== toolSet || codexDraft !== codex);

      const options = OPTIONS.map((option) =>
        h("option", { key: option.value, value: option.value }, option.label),
      );

      const header = h(
        "div",
        { style: S.block },
        h(
          "div",
          { style: S.headRow },
          h("h2", { style: S.h1 }, "会话检索"),
          h(
            "div",
            { style: S.row },
            h("span", { style: S.label }, "工具集"),
            h(
              "select",
              {
                style: S.select,
                value: draft,
                title: "决定哪些会话检索工具对模型可见",
                disabled: busy === "save",
                onChange: (event) => {
                  setDraft(event.target.value);
                  setNotice(null);
                },
              },
              options,
            ),
            h(
              "button",
              {
                type: "button",
                style: busy !== null ? S.btnOff : S.btn,
                disabled: busy !== null,
                title: "保存并立即应用",
                onClick: onSave,
              },
              busy === "save" ? "保存中…" : "保存",
            ),
          ),
        ),
        h(
          "div",
          { style: S.hint },
          "决定哪些会话检索工具对模型可见：切到 sessiongraph 会隐藏宿主的 session_search 系列，"
            + "切到 kernel 会隐藏本插件的 sessiongraph，both 两个都留。改动立刻生效，不需重启。",
        ),
      );

      const codexBlock = h(
        "div",
        { style: S.block },
        h(
          "label",
          { style: S.checkRow },
          h("input", {
            type: "checkbox",
            checked: codexDraft === true,
            disabled: busy === "save",
            role: "switch",
            "data-sessiongraph-codex": "",
            onChange: (event) => {
              const next = event.target.checked === true;
              // 乐观更新：先把开关拨到用户点的位置，请求失败再拨回去 —— 等一个往返才动会显得卡。
              setCodexDraft(next);
              setNotice(null);
              persist(draft, next, next === false);
            },
          }),
          h("span", { style: S.label }, "同步 Codex 的历史会话"),
        ),
        h(
          "div",
          { style: S.hint },
          "打开后，~/.codex 下的 rollout 日志会和 DSH 自己的会话一起进索引，"
            + "用 source=codex 可以只看这一侧；关掉后下次索引运行会把这些行删掉。"
            + "这个开关不会动你的 Codex 数据，只决定读不读。",
        ),
      );

      const notes = h(
        "div",
        { style: S.options },
        OPTIONS.map((option) =>
          h(
            "div",
            { key: option.value, style: option.value === draft ? S.option : S.muted },
            option.value + " — " + option.note,
          ),
        ),
      );

      const status = availabilityText(available);

      return h(
        "div",
        { style: S.root, "data-sessiongraph-panel": "" },
        header,
        codexBlock,
        notes,
        status ? h("div", { style: S.mono }, status) : null,
        error ? h("div", { style: S.danger, role: "alert" }, error) : null,
        notice ? h("div", { style: S.okText, role: "status" }, notice) : null,
        busy === "load" ? h("div", { style: S.muted }, "读取当前设置…") : null,
        dirty ? h("div", { style: S.muted }, "有未保存的改动。") : null,
      );
    }

    /**
     * 注册「会话检索」tab。
     *
     * 两处都单独 try/catch：注册抛错会让 DSH 把 web 判成 failed，
     * 一个 tab 不该拖垮整个客户端。
     */
    function apply(ctx) {
      try {
        ctx.slots.inject("settings.section", () => {
          try {
            return ctx.slots.register(
              {
                name: "settings.section",
                id: "sessiongraph",
                order: 31,
                label: () => "会话检索",
              },
              SessiongraphSection,
            );
          } catch (err) {
            console.warn("[sessiongraph] 注册 settings.section 失败：", err);
            return null;
          }
        });
      } catch (err) {
        console.warn("[sessiongraph] 注入 settings.section 失败：", err);
      }
    }

    exports.name = "sessiongraph-panel-client";
    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
