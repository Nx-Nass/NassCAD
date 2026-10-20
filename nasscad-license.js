/* Copyright (C) 2026 NassLab — Nasser, France.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(() => {
  'use strict';
  const notices = [...document.querySelectorAll('details.nass-license')];
  document.addEventListener('click', event => {
    for (const notice of notices) if (notice.open && !notice.contains(event.target)) notice.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    for (const notice of notices) if (notice.open) {
      notice.open = false;
      notice.querySelector('summary')?.focus();
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
})();
