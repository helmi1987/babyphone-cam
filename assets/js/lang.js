// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm
// Root page: send the visitor to the language folder that matches the browser (default: en).
(function () {
  'use strict';
  var supported = ['de', 'en', 'it', 'fr'];
  var alias = { gsw: 'de' };
  var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
  var pick = 'en';
  for (var i = 0; i < list.length; i++) {
    var code = String(list[i] || '').toLowerCase().split('-')[0];
    code = alias[code] || code;
    if (supported.indexOf(code) !== -1) { pick = code; break; }
  }
  location.replace(pick + '/' + location.hash);
})();
