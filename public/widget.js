(function () {
  "use strict";
  window.SupportHub = {
    mount: function (options) {
      var base = new URL(options.baseUrl),
        origin = base.origin;
      var button = document.createElement("button"),
        panel = document.createElement("div"),
        frame = document.createElement("iframe");
      button.textContent = "✦ 联系客服";
      button.setAttribute("aria-label", "打开 AI 客服");
      button.style.cssText =
        "position:fixed;right:24px;bottom:24px;z-index:9998;border:0;border-radius:28px;padding:15px 23px;background:#4f46e5;color:#fff;cursor:pointer;box-shadow:0 8px 30px #4f46e533;font:600 15px sans-serif";
      panel.style.cssText =
        "display:none;position:fixed;right:16px;bottom:84px;width:min(800px,calc(100vw - 32px));height:min(760px,calc(100dvh - 110px));z-index:9999;background:white;border-radius:18px;overflow:hidden;box-shadow:0 15px 60px #14254b33";
      frame.title = "AI 客服与工单";
      frame.style.cssText = "width:100%;height:100%;border:0";
      panel.appendChild(frame);
      document.body.append(button, panel);
      var bootstrap = null,
        disposed = false,
        loading = null;
      function initialize() {
        if (loading) return loading;
        loading = Promise.resolve(options.bootstrap())
          .then(function (b) {
            if (disposed) return;
            if (new URL(b.publicUrl).origin !== origin)
              throw Error("客服地址不匹配");
            bootstrap = b;
            var url =
              origin + "/widget?project=" + encodeURIComponent(b.project.code);
            if (frame.src !== url) frame.src = url;
            else
              frame.contentWindow.postMessage(
                { type: "support:init", bootstrap: b },
                origin,
              );
          })
          .catch(function (e) {
            button.textContent = "客服连接失败，点击重试";
            if (options.onError) options.onError(e);
          })
          .finally(function () {
            loading = null;
          });
        return loading;
      }
      button.onclick = function () {
        panel.style.display = panel.style.display === "none" ? "block" : "none";
        if (panel.style.display === "block") {
          button.textContent = "✦ 联系客服";
          initialize();
        }
      };
      function receive(e) {
        if (e.origin !== origin || e.source !== frame.contentWindow) return;
        if (e.data && e.data.type === "support:ready" && bootstrap)
          frame.contentWindow.postMessage(
            { type: "support:init", bootstrap: bootstrap },
            origin,
          );
        if (e.data && e.data.type === "support:refresh") initialize();
        if (e.data && e.data.type === "support:close")
          panel.style.display = "none";
      }
      window.addEventListener("message", receive);
      return {
        open: function () {
          panel.style.display = "block";
          return initialize();
        },
        destroy: function () {
          disposed = true;
          window.removeEventListener("message", receive);
          button.remove();
          panel.remove();
          bootstrap = null;
        },
      };
    },
  };
})();
