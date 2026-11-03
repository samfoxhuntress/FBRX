// The download page: the installer for this visitor's computer comes first, with a button of its own at the top.
(function () {
  'use strict';
  var ua = navigator.userAgent || '';
  var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  // Phones and tablets get no guess: FBRX is for computers (an iPad can say it is a Mac).
  if (/Android|iPhone|iPad|iPod/.test(ua) || (/Mac/.test(platform) && navigator.maxTouchPoints > 1)) return;
  var os = /Win/i.test(platform) || /Windows/.test(ua) ? 'windows' : /Mac/i.test(platform) || /Macintosh/.test(ua) ? 'mac' : /Linux/i.test(platform) || /Linux|X11/.test(ua) ? 'linux' : null;
  if (!os) return;
  var card = document.querySelector('.os[data-os="' + os + '"]');
  var first = card && card.querySelector('a.btn.primary');
  if (!first) return;
  card.classList.add('mine');
  card.parentNode.insertBefore(card, card.parentNode.firstChild);
  var link = document.getElementById('for-you-link');
  link.href = first.href;
  link.textContent = first.getAttribute('data-label') || first.textContent;
  document.getElementById('for-you').hidden = false;
})();
