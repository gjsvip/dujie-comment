/* ============================================================
   dujie-comment 嵌入组件（vanilla JS，零依赖，零构建）
   用法：
     <link rel="stylesheet" href="https://<your-worker>/client/dujie-comment.css">
     <div data-dujie-comment
          data-api="https://<your-worker>"
          data-slug="my-post-1"
          data-author="博主昵称1,博主昵称2"
          data-post-stats="1"></div>
     <script src="https://<your-worker>/client/dujie-comment.js" defer></script>
   配置项（script 或容器上的 data-*）：
     data-api        必填，Worker 地址（不含末尾斜杠）
     data-slug       可选，文章标识；缺省依次取 URL ?slug= 与路径末段
     data-author     可选，逗号分隔的博主昵称（评论旁显示「博主」徽章）
     data-title      可选，评论区标题（缺省「评论」）
     data-post-stats 可选，=1 时显示文章浏览/点赞芯片并自动 +1 浏览
     data-no-view    可选，=1 时关闭自动浏览 +1
   ============================================================ */
(function () {
  'use strict';
  if (typeof document === 'undefined') return; // SSR / Worker 环境安全

  /* ---------- 配置 ---------- */
  function currentScript() {
    if (document.currentScript) return document.currentScript;
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) {
      if (/dujie-comment\.js(\?|$)/.test(all[i].src || '')) return all[i];
    }
    return null;
  }
  function attrOf(el, name) { return el && el.getAttribute(name) ? el.getAttribute(name).trim() : ''; }

  var script = currentScript();
  var cfgEl = document.querySelector('[data-dujie-comment]') || (script && script.parentNode);
  var API = attrOf(script, 'data-api') || attrOf(cfgEl, 'data-api');
  var SLUG = attrOf(script, 'data-slug') || attrOf(cfgEl, 'data-slug');
  var AUTHORS = (attrOf(script, 'data-author') || attrOf(cfgEl, 'data-author') || '')
    .split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
  var TITLE = attrOf(script, 'data-title') || attrOf(cfgEl, 'data-title') || '评论';
  var POST_STATS = (attrOf(script, 'data-post-stats') || attrOf(cfgEl, 'data-post-stats')) === '1';
  var NO_VIEW = (attrOf(script, 'data-no-view') || attrOf(cfgEl, 'data-no-view')) === '1';

  function detectSlug() {
    try {
      var q = new URLSearchParams(location.search).get('slug');
      if (q && q.trim()) return q.trim();
    } catch (e) {}
    // 兼容三种形态：/posts/xxx.html、/posts/xxx（无扩展名规范 URL）、/posts/xxx/
    var m = location.pathname.match(/posts\/([^/]+?)(?:\.html)?\/?$/);
    if (m) return decodeURIComponent(m[1]);
    var seg = location.pathname.split('/').filter(function (s) { return s !== ''; }).pop();
    return seg || 'index';
  }
  if (!SLUG) SLUG = detectSlug();

  if (!API) { console.error('[dujie-comment] 缺少 data-api 配置（Worker 地址）'); return; }
  API = API.replace(/\/+$/, '');
  if (!cfgEl) { console.error('[dujie-comment] 未找到挂载容器（[data-dujie-comment] 或 script 父元素）'); return; }

  /* ---------- 常量与工具 ---------- */
  var CONFIG_CACHE_KEY = 'dujie-comment-config';
  var CONFIG_TTL_MS = 5 * 60 * 1000;
  var LIKED_COMMENTS_KEY = 'dujie-comment-liked-comments';
  var LIKED_POSTS_KEY = 'dujie-comment-liked-posts';
  var NICK_KEY = 'dujie-comment-nick';
  var MAIL_KEY = 'dujie-comment-mail';
  var EMOJIS = ['😀','😂','🥰','😎','🤔','😴','😭','😡','👍','👎','🙏','👏','🔥','💯','✨','🎉','❤️','💔','⭐','🌈','☀️','🌙','⚡','🍺','☕','🐟','🐱','🐶','🚀','💻','📚','✍️','🧧','🛠️','⚠️'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(s, el) { return (el || document).querySelector(s); }
  function $$(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
  function timeAgo(ts) {
    var d = Date.now() - new Date(ts).getTime();
    var m = Math.floor(d / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    var day = Math.floor(h / 24);
    if (day < 30) return day + ' 天前';
    var mo = Math.floor(day / 30);
    if (mo < 12) return mo + ' 个月前';
    return Math.floor(mo / 12) + ' 年前';
  }
  function toast(msg, type) {
    var wrap = document.getElementById('dc-toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.id = 'dc-toast-wrap'; document.body.appendChild(wrap); }
    var t = document.createElement('div');
    t.className = 'dc-toast ' + (type || '');
    t.innerHTML = (type === 'ok' ? '✅ ' : type === 'err' ? '❌ ' : '💬 ') + esc(msg);
    wrap.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; t.style.transform = 'translateY(10px)'; t.style.transition = 'all .35s'; }, 2600);
    setTimeout(function () { t.remove(); }, 3100);
  }
  function api(path, opts) {
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || (j && j.code !== 0)) {
          throw Object.assign(new Error((j && j.message) || 'HTTP ' + r.status), { code: j && j.code, status: r.status });
        }
        return j;
      });
    }).then(function (j) {
      if (j && j.code === 0) return j.data;
      throw new Error((j && j.message) || '接口错误');
    });
  }
  function readLiked(key) {
    try {
      var raw = localStorage.getItem(key);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveLiked(key, id) {
    try {
      var arr = readLiked(key);
      if (arr.map(String).indexOf(String(id)) === -1) { arr.push(id); localStorage.setItem(key, JSON.stringify(arr)); }
    } catch (e) {}
  }
  function forgetLiked(key, id) {
    try {
      localStorage.setItem(key, JSON.stringify(readLiked(key).filter(function (x) { return String(x) !== String(id); })));
    } catch (e) {}
  }
  function isLiked(key, id) {
    return readLiked(key).some(function (x) { return String(x) === String(id); });
  }

  /* ---------- 远端配置 + Turnstile ---------- */
  var remoteConfig = null;
  var turnstileToken = '';
  var turnstileWidgetId = null;

  function loadRemoteConfig() {
    var cached = null;
    try {
      var raw = localStorage.getItem(CONFIG_CACHE_KEY);
      if (raw) {
        var obj = JSON.parse(raw);
        if (obj && obj.at && Date.now() - obj.at < CONFIG_TTL_MS) cached = obj.data;
      }
    } catch (e) {}
    if (cached) return Promise.resolve(cached);
    return fetch(API + '/api/config')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.code === 0 && j.data) {
          try { localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify({ at: Date.now(), data: j.data })); } catch (e) {}
        }
        return j.data || null;
      })
      .catch(function () { return null; }); // 失败按「全关」保守降级
  }
  function initTurnstile(rc) {
    if (!rc || !rc.turnstile || !rc.turnstile.enabled || !rc.turnstile.siteKey) return Promise.resolve();
    var slot = document.getElementById('dc-turnstile-slot');
    if (!slot) return Promise.resolve();
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    s.async = true; s.defer = true;
    document.head.appendChild(s);
    return new Promise(function (res) { s.onload = res; s.onerror = res; })
      .then(function () {
        if (!window.turnstile) return; // 脚本加载失败：按未开启处理（后端 fail-open 兜底）
        turnstileWidgetId = window.turnstile.render('#dc-turnstile-slot', {
          sitekey: rc.turnstile.siteKey,
          callback: function (t) { turnstileToken = t; },
          'expired-callback': function () { turnstileToken = ''; },
          'error-callback': function () { turnstileToken = ''; }
        });
      });
  }
  function resetTurnstile() {
    if (turnstileWidgetId !== null && window.turnstile) {
      try { window.turnstile.reset(turnstileWidgetId); } catch (e) {}
    }
    turnstileToken = '';
  }
  function afterSubmit(d) {
    if (d && d.status === 'pending') toast('已提交，待审核后展示', 'ok');
    else toast('评论发布成功', 'ok');
    resetTurnstile();
  }
  function onSubmitError(err) {
    if (err && (err.code === 'TURNSTILE_FAILED' || err.code === 'TURNSTILE_TOKEN_MISSING')) {
      resetTurnstile();
      toast('请重新完成人机校验', 'err');
    } else if (err && err.code === 'TURNSTILE_UNAVAILABLE') {
      toast('校验服务暂不可用，请稍后重试', 'err');
    } else if (err && err.code === 'BANNED') {
      toast('评论被拒绝，如有疑问请联系博主', 'err');
    } else if (err && err.code === 'RATE_LIMITED') {
      toast('评论太频繁了，休息一分钟再来吧', 'err');
    } else {
      toast((err && err.message) || '发布失败', 'err');
    }
  }

  /* ---------- 骨架渲染 ---------- */
  cfgEl.classList.add('dc-root');
  cfgEl.innerHTML =
    '<div class="dc-head">' +
      '<span class="dc-title">💬 ' + esc(TITLE) + ' <span class="dc-count" id="dc-count">0</span></span>' +
      (POST_STATS ? '<span class="dc-post-stats">' +
        '<span class="dc-chip">👁 <b id="dc-post-views">-</b></span>' +
        '<button type="button" class="dc-chip dc-post-like" id="dc-post-like-btn">❤️ <b id="dc-post-likes">-</b></button>' +
      '</span>' : '') +
    '</div>' +
    '<form class="dc-form" id="dc-form">' +
      '<div class="dc-row">' +
        '<input id="dc-nickname" type="text" maxlength="20" placeholder="昵称 *" autocomplete="nickname">' +
        '<input id="dc-email" type="email" placeholder="邮箱（选填，仅通知用）" autocomplete="email">' +
      '</div>' +
      '<textarea id="dc-content" maxlength="500" placeholder="说点什么吧…"></textarea>' +
      '<div class="dc-turnstile-slot" id="dc-turnstile-slot"></div>' +
      '<div class="dc-foot">' +
        '<button type="button" class="dc-emoji-btn" id="dc-emoji-btn" title="表情">😊</button>' +
        '<div class="dc-emoji-panel" id="dc-emoji-panel"></div>' +
        '<button type="submit" class="dc-submit" id="dc-submit">发布评论</button>' +
      '</div>' +
    '</form>' +
    '<div class="dc-list" id="dc-list"><div class="dc-loading">评论加载中…</div></div>';

  /* ---------- 评论树 ---------- */
  function renderComment(c, isReply) {
    var av = c.avatar || '';
    var initial = esc((c.nickname || '?').charAt(0).toUpperCase());
    var avatarHtml = av
      ? '<img src="' + esc(av) + '" alt="' + esc(c.nickname) + '" loading="lazy" onerror="this.parentNode.textContent=\'' + initial + '\'">'
      : initial;
    var isAuthor = AUTHORS.indexOf(c.nickname) > -1;
    var html = '<div class="dc-comment' + (isReply ? ' dc-reply' : '') + '" data-id="' + c.id + '">' +
      '<div class="dc-avatar">' + avatarHtml + '</div>' +
      '<div class="dc-main">' +
        '<div class="dc-c-head"><span class="dc-name">' + esc(c.nickname) + '</span>' +
        (isAuthor ? '<span class="dc-badge">博主</span>' : '') +
        (c.website ? '<a class="dc-site" href="' + esc(c.website) + '" target="_blank" rel="noopener nofollow">🔗</a>' : '') +
        '<time datetime="' + esc(c.createdAt || c.created_at) + '">' + esc(timeAgo(c.createdAt || c.created_at)) + '</time></div>' +
        '<div class="dc-text">' + esc(c.content) + '</div>' +
        '<div class="dc-c-foot">' +
          '<button type="button" class="dc-like' + (isLiked(LIKED_COMMENTS_KEY, c.id) ? ' liked' : '') + '" data-id="' + c.id + '">❤️ <b>' + (c.likes || 0) + '</b></button>' +
          '<button type="button" class="dc-reply-btn" data-id="' + c.id + '" data-name="' + esc(c.nickname) + '">💬 回复</button>' +
        '</div>' +
        '<div class="dc-reply-box" id="dc-reply-' + c.id + '">' +
          '<textarea placeholder="回复 @' + esc(c.nickname) + ' …"></textarea>' +
          '<div class="dc-rb-foot"><button type="button" class="dc-rb-submit">发送回复</button><button type="button" class="dc-rb-cancel">取消</button></div>' +
        '</div>' +
      '</div></div>';
    if (c.replies && c.replies.length) {
      html += '<div class="dc-replies">' + c.replies.map(function (r) { return renderComment(r, true); }).join('') + '</div>';
    }
    return html;
  }
  function bindCommentActions(root) {
    $$('.dc-like', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        api('/api/like', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment_id: Number(id) })
        }).then(function (d) {
          btn.classList.toggle('liked', !!d.liked);
          $('b', btn).textContent = d.likes;
          if (d.liked) saveLiked(LIKED_COMMENTS_KEY, id); else forgetLiked(LIKED_COMMENTS_KEY, id);
        }).catch(function (e) { toast(e.message, 'err'); });
      });
    });
    $$('.dc-reply-btn', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        $$('.dc-reply-box').forEach(function (b) { if (b.id !== 'dc-reply-' + id) b.classList.remove('open'); });
        var box = document.getElementById('dc-reply-' + id);
        box.classList.toggle('open');
        if (box.classList.contains('open')) $('textarea', box).focus();
      });
    });
    $$('.dc-rb-cancel', root).forEach(function (btn) {
      btn.addEventListener('click', function () { btn.closest('.dc-reply-box').classList.remove('open'); });
    });
    $$('.dc-rb-submit', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var box = btn.closest('.dc-reply-box');
        var id = box.id.replace('dc-reply-', '');
        var text = $('textarea', box).value.trim();
        if (!text) { toast('回复内容不能为空', 'err'); return; }
        var nick = ($('#dc-nickname').value.trim() || '匿名访客');
        btn.disabled = true;
        api('/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: SLUG, nickname: nick, email: $('#dc-email').value.trim(),
            content: text, parentId: Number(id), turnstileToken: turnstileToken
          })
        }).then(function (d) {
          afterSubmit(d);
          $('textarea', box).value = '';
          box.classList.remove('open');
          loadComments();
        }).catch(function (e) { onSubmitError(e); btn.disabled = false; });
      });
    });
  }
  function loadComments() {
    var box = document.getElementById('dc-list');
    if (!box) return;
    api('/api/comments?slug=' + encodeURIComponent(SLUG)).then(function (data) {
      var list = (data && data.comments) || [];
      var cnt = document.getElementById('dc-count');
      if (cnt) cnt.textContent = (data && data.total != null) ? data.total : list.length;
      if (!list.length) {
        box.innerHTML = '<div class="dc-empty"><div class="dc-big">💬</div>还没有评论，来抢个沙发吧～</div>';
        return;
      }
      box.innerHTML = list.map(function (c) { return renderComment(c, false); }).join('');
      bindCommentActions(box);
    }).catch(function (e) {
      box.innerHTML = '<div class="dc-empty"><div class="dc-big">⚠️</div>评论加载失败：' + esc(e.message) + '</div>';
    });
  }

  /* ---------- 文章级统计 / 点赞（data-post-stats=1 时启用） ---------- */
  function initPostStats() {
    if (!POST_STATS) return;
    if (!NO_VIEW) {
      api('/api/view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: SLUG })
      }).catch(function () {});
    }
    var likeBtn = document.getElementById('dc-post-like-btn');
    if (isLiked(LIKED_POSTS_KEY, SLUG) && likeBtn) likeBtn.classList.add('liked');
    api('/api/stats?slugs=' + encodeURIComponent(SLUG)).then(function (data) {
      var s = (Array.isArray(data) ? data[0] : (data && data[SLUG])) || {};
      var v = document.getElementById('dc-post-views'), l = document.getElementById('dc-post-likes');
      if (v) v.textContent = s.views || 0;
      if (l) l.textContent = s.likes || 0;
      if (likeBtn) {
        likeBtn.addEventListener('click', function () {
          api('/api/like', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug: SLUG })
          }).then(function (d) {
            likeBtn.classList.toggle('liked', !!d.liked);
            if (l) l.textContent = d.likes;
            if (d.liked) saveLiked(LIKED_POSTS_KEY, SLUG); else forgetLiked(LIKED_POSTS_KEY, SLUG);
            toast(d.liked ? '感谢点赞 ❤️' : '已取消点赞');
          }).catch(function (e) { toast(e.message, 'err'); });
        });
      }
    }).catch(function () {});
  }

  /* ---------- 表单 ---------- */
  function initForm() {
    // 记忆昵称/邮箱
    try {
      var n = localStorage.getItem(NICK_KEY), m = localStorage.getItem(MAIL_KEY);
      if (n) document.getElementById('dc-nickname').value = n;
      if (m) document.getElementById('dc-email').value = m;
    } catch (e) {}
    // emoji 面板
    var panel = document.getElementById('dc-emoji-panel'), ta = document.getElementById('dc-content');
    panel.innerHTML = EMOJIS.map(function (e) { return '<button type="button">' + e + '</button>'; }).join('');
    $$('button', panel).forEach(function (b) {
      b.addEventListener('click', function () { ta.value += b.textContent; ta.focus(); });
    });
    document.getElementById('dc-emoji-btn').addEventListener('click', function () { panel.classList.toggle('open'); });
    // 提交
    document.getElementById('dc-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var nick = document.getElementById('dc-nickname').value.trim();
      var content = ta.value.trim();
      if (!nick) { toast('先填个昵称吧', 'err'); document.getElementById('dc-nickname').focus(); return; }
      if (!content) { toast('评论内容不能为空', 'err'); ta.focus(); return; }
      var btn = document.getElementById('dc-submit');
      btn.disabled = true; btn.textContent = '发送中…';
      try {
        localStorage.setItem(NICK_KEY, nick);
        localStorage.setItem(MAIL_KEY, document.getElementById('dc-email').value.trim());
      } catch (err) {}
      api('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: SLUG, nickname: nick, email: document.getElementById('dc-email').value.trim(),
          content: content, turnstileToken: turnstileToken
        })
      }).then(function (d) {
        afterSubmit(d);
        ta.value = '';
        loadComments();
      }).catch(function (err) { onSubmitError(err); })
        .then(function () { btn.disabled = false; btn.textContent = '发布评论'; });
    });
  }

  /* ---------- 启动 ---------- */
  loadComments();
  initForm();
  initPostStats();
  loadRemoteConfig().then(function (rc) {
    remoteConfig = rc;
    return initTurnstile(rc);
  }).catch(function () {});
})();
