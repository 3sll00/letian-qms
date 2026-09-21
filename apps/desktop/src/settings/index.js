/**
 * 服务器设置窗口脚本（以外部文件引用，满足页面 CSP 'self' 约束）。
 * 依赖 preload 注入的 window.desktop 桥接能力。
 */
(function () {
  var input = document.getElementById('server-url');
  var result = document.getElementById('result');
  var btnTest = document.getElementById('btn-test');
  var btnSave = document.getElementById('btn-save');
  var desktop = window.desktop;

  function show(kind, text) {
    result.className = kind;
    result.textContent = text;
  }

  desktop.getSettings().then(function (config) {
    input.value = config.serverUrl || '';
  });

  input.addEventListener('input', function () {
    input.classList.remove('invalid');
    result.textContent = '';
    result.className = '';
  });

  btnTest.addEventListener('click', function () {
    btnTest.disabled = true;
    show('', '正在连接...');
    desktop.testConnection(input.value).then(function (r) {
      show(r.ok ? 'ok' : 'err', r.message);
      btnTest.disabled = false;
    });
  });

  btnSave.addEventListener('click', function () {
    btnSave.disabled = true;
    desktop.saveSettings(input.value).then(function (r) {
      if (r.ok) {
        show('ok', '已保存，主界面正在重新加载...');
        setTimeout(function () { window.close(); }, 600);
      } else {
        show('err', r.error);
        input.classList.add('invalid');
        btnSave.disabled = false;
      }
    });
  });
})();
