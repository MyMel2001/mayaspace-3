/* MayaSpace client enhancements. No frameworks — it's 2006 in here. */
(function () {
  "use strict";

  /* ── confirm-before-delete forms ─────────────────────────── */
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (form instanceof HTMLFormElement && form.classList.contains("confirm-delete")) {
      var msg = form.getAttribute("data-confirm") || "Are you sure?";
      if (!window.confirm(msg)) {
        ev.preventDefault();
      }
    }
  });

  /* ── like buttons without a full page reload ─────────────── */
  document.addEventListener("click", function (ev) {
    var btn = ev.target instanceof Element ? ev.target.closest(".like-btn") : null;
    if (!btn) return;
    var form = btn.closest("form.like-form");
    if (!form) return;
    ev.preventDefault();

    var csrf = form.querySelector('input[name="csrf"]');
    var postId = form.getAttribute("data-post-id");
    if (!csrf || !postId) {
      form.submit();
      return;
    }

    var body = new URLSearchParams();
    body.set("csrf", csrf.value);
    body.set("ajax", "1");

    fetch("/posts/" + encodeURIComponent(postId) + "/like", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      credentials: "same-origin",
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        btn.classList.toggle("liked", !!data.liked);
        var count = btn.querySelector(".like-count");
        if (count && typeof data.likeCount === "number") count.textContent = String(data.likeCount);
      })
      .catch(function () {
        form.submit(); // graceful fallback
      });
  });

  /* ── image lightbox ──────────────────────────────────────── */
  var lightbox = document.createElement("div");
  lightbox.className = "lightbox";
  lightbox.setAttribute("role", "dialog");
  lightbox.setAttribute("aria-label", "Image preview");
  var lightboxImg = document.createElement("img");
  lightboxImg.alt = "";
  lightbox.appendChild(lightboxImg);
  document.body.appendChild(lightbox);

  document.addEventListener("click", function (ev) {
    if (lightbox.classList.contains("open")) {
      lightbox.classList.remove("open");
      if (ev.target === lightbox) ev.preventDefault();
      return;
    }
    var img = ev.target instanceof Element ? ev.target.closest(".post-img") : null;
    if (!img) return;
    ev.preventDefault();
    var full = img.getAttribute("data-full") || img.getAttribute("src");
    if (full) {
      lightboxImg.src = full;
      lightbox.classList.add("open");
    }
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") lightbox.classList.remove("open");
  });

  /* ── composer upload previews ────────────────────────────── */
  var fileInput = document.getElementById("composer-files");
  var previews = document.getElementById("composer-previews");
  var composer = document.getElementById("composer");
  if (fileInput && previews && composer) {
    var uploadInFlight = 0;

    fileInput.addEventListener("change", function () {
      if (!fileInput.files || fileInput.files.length === 0) return;
      var files = Array.prototype.slice.call(fileInput.files).slice(0, 4);

      var csrfInput = composer.querySelector('input[name="csrf"]');
      var fd = new FormData();
      if (csrfInput) fd.append("csrf", csrfInput.value);
      files.forEach(function (f) {
        fd.append("files", f, f.name);
        var wrap = document.createElement("div");
        wrap.className = "preview-thumb";
        var thumb = document.createElement("img");
        thumb.src = URL.createObjectURL(f);
        var status = document.createElement("span");
        status.className = "preview-status";
        status.textContent = "…";
        wrap.appendChild(thumb);
        wrap.appendChild(status);
        wrap.dataset.name = f.name;
        previews.appendChild(wrap);
      });

      uploadInFlight++;
      fetch("/uploads", {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (data) {
          uploadInFlight--;
          mergeAttachmentIds(data.attachments || []);
          Array.prototype.forEach.call(previews.children, function (wrap) {
            var match = (data.attachments || []).find(function (a) {
              return a.name === wrap.dataset.name;
            });
            var status = wrap.querySelector(".preview-status");
            if (match) {
              if (status) status.remove();
              wrap.querySelector("img").src = match.thumbUrl;
            } else if (status) {
              status.textContent = "✕";
              setTimeout(function () {
                wrap.remove();
              }, 1500);
            }
          });
        })
        .catch(function () {
          uploadInFlight--;
          Array.prototype.forEach.call(previews.children, function (wrap) {
            var status = wrap.querySelector(".preview-status");
            if (status) status.textContent = "✕";
          });
        });

      fileInput.value = ""; // allow re-choosing the same file
    });

    function mergeAttachmentIds(list) {
      var idsField = document.getElementById("composer-attachment-ids");
      if (!idsField) return;
      var ids = idsField.value === "" ? [] : idsField.value.split(",");
      list.forEach(function (a) {
        if (a && a.id && ids.indexOf(a.id) === -1) ids.push(a.id);
      });
      idsField.value = ids.slice(0, 4).join(",");
    }
  }
})();