// What a month comes to for an organization: the FBRX Command plan and each computer at its edition.
(function () {
  'use strict';
  var form = document.getElementById('calc');
  if (!form) return;
  var p = JSON.parse(form.getAttribute('data-prices'));
  var out = document.getElementById('total');
  function money(cents) {
    return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function n(name) {
    return Math.max(0, Math.floor(Number(form.elements[name].value) || 0));
  }
  function update() {
    out.textContent = money(p.command + n('basic') * p.basic + n('ultra') * p.ultra + n('blackhole') * p.blackhole);
  }
  form.addEventListener('input', update);
  form.addEventListener('submit', function (e) {
    e.preventDefault();
  });
  update();
})();
