/**
 * Today client enhancement script + the ADR-0022 CSP (amends ADR-0019's
 * "no client JS / default-src 'none'").
 *
 * ONE static vanilla script, embedded as a template literal at module load:
 * no framework, no build step, no external fetches beyond same-origin /ui.
 * Every enhancement is an OPTIMIZATION that degrades silently to the exact
 * server-rendered behavior (no-JS parity is a tested contract):
 *
 *   a. Optimistic action buttons — submit interception only sets a loading
 *      state (disabled + aria-busy + data-loading); the POST proceeds
 *      normally. The server response is authoritative; the next page render
 *      is the fresh state. Never preventDefault, never fetch() here.
 *   b. Refresh-on-focus — visibilitychange → same-origin GET of location →
 *      swap ONLY the [data-main] region's innerHTML. Absent marker → no-op;
 *      a focused input inside the region aborts the swap (never eats typing).
 *   c. Undo toast — when the page carries [data-undo-form] (Lane B), a
 *      transient aria-live toast offers Undo; the form ITSELF performs the
 *      POST (requestSubmit). The script only styles and announces.
 *   d. Delegate reveal — clicking [data-reveal-extra] un-hides the
 *      [data-extra] rows Lane C marked. Absent attributes = no-op.
 *   e. Character hints — live "n / maxlength" captions under the delegate
 *      form's maxlength fields (plan §3 Lane D "character hints").
 *
 * SECURITY (ADR-0022 §threat analysis): the script is a static template
 * literal in the API — no user data ever enters it (data stays escaped in
 * the HTML by the ADR-0019 escape-at-boundary rule), so an attacker cannot
 * shift the bytes that the CSP hash pins. The hash is computed from
 * TODAY_SCRIPT at module load, in the same module that serves both the
 * script and the header: any drift fails closed (the browser blocks the
 * script) and the ui.routes drift test fails the build instead.
 */

import { createHash } from "node:crypto";

export const TODAY_SCRIPT = `(function () {
  "use strict";
  var doc = document;
  var win = window;
  var remove = function (node) {
    if (node.parentNode !== null) node.parentNode.removeChild(node);
  };
  var boot = function () {
    var style = doc.createElement("style");
    style.textContent =
      '[data-loading]{opacity:.55;pointer-events:none}' +
      '[data-undo-toast]{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 1rem);z-index:50;max-width:min(24rem,92vw);background:#1c1c1e;color:#f2f2f7;border-radius:14px;padding:.5rem .5rem .5rem 1rem;font:400 15px/1.35 system-ui,sans-serif;display:flex;align-items:center;gap:.25rem;box-shadow:0 8px 30px rgba(0,0,0,.28)}' +
      '[data-undo-toast] button{background:none;border:0;color:#64aefc;font:inherit;font-weight:600;min-height:44px;min-width:44px;border-radius:10px;cursor:pointer}' +
      '[data-char-hint]{display:block;color:#8e8e93;font-size:13px;line-height:1.4;margin-top:.15rem;min-height:1.2em}' +
      '@media(prefers-color-scheme:dark){[data-undo-toast]{background:#2c2c2e}[data-char-hint]{color:#98989d}}' +
      '@media(prefers-reduced-motion:no-preference){[data-loading]{transition:opacity .15s ease-out}[data-undo-toast]{animation:today-toast-in .18s ease-out}@keyframes today-toast-in{from{opacity:0;transform:translateX(-50%) translateY(8px)}}}';
    if (doc.head !== null) doc.head.appendChild(style);

    // a. optimistic action buttons — server stays authoritative
    doc.addEventListener("submit", function (event) {
      var form = event.target;
      if (!form || form.getAttribute("action") !== "/ui/action") return;
      var button = event.submitter;
      if (!button) {
        var candidates = form.querySelectorAll('button[type="submit"],button:not([type])');
        button = candidates.length > 0 ? candidates[candidates.length - 1] : null;
      }
      if (!button || button.disabled) return;
      button.setAttribute("data-loading", "");
      button.setAttribute("aria-busy", "true");
      button.disabled = true;
    }, true);

    // b. refresh-on-focus — swap only the [data-main] region, same-origin only
    if (typeof win.fetch === "function" && typeof win.DOMParser === "function" && typeof doc.visibilityState === "string") {
      var inFlight = false;
      doc.addEventListener("visibilitychange", function () {
        if (doc.visibilityState !== "visible" || inFlight) return;
        var target = doc.querySelector("[data-main]");
        if (target === null) return;
        var active = doc.activeElement;
        if (active !== null && target.contains(active) && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
        inFlight = true;
        win.fetch(win.location.href, { credentials: "same-origin", headers: { accept: "text/html" } })
          .then(function (res) { return res.ok ? res.text() : null; })
          .then(function (html) {
            inFlight = false;
            if (typeof html !== "string" || doc.visibilityState !== "visible") return;
            var fresh = new win.DOMParser().parseFromString(html, "text/html").querySelector("[data-main]");
            if (fresh !== null) target.innerHTML = fresh.innerHTML;
          })
          .catch(function () { inFlight = false; });
      });
    }

    // c. undo toast — announces; the [data-undo-form] itself posts
    var undoForm = doc.querySelector("[data-undo-form]");
    if (undoForm !== null && doc.body !== null) {
      var toast = doc.createElement("div");
      toast.setAttribute("data-undo-toast", "");
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      var dismiss = function () { remove(toast); };
      var message = doc.createElement("span");
      message.textContent = (undoForm.getAttribute("data-undo-label") || "Done.") + " Undo?";
      var undoButton = doc.createElement("button");
      undoButton.type = "button";
      undoButton.textContent = "Undo";
      undoButton.addEventListener("click", function () {
        if (typeof undoForm.requestSubmit === "function") undoForm.requestSubmit();
        else undoForm.submit();
        dismiss();
      });
      toast.appendChild(message);
      toast.appendChild(undoButton);
      doc.body.appendChild(toast);
      win.setTimeout(dismiss, 8000);
    }

    // d. delegate extras reveal — one click un-hides every marked row
    doc.addEventListener("click", function (event) {
      var node = event.target;
      if (!node || typeof node.closest !== "function") return;
      var trigger = node.closest("[data-reveal-extra]");
      if (trigger === null) return;
      var extras = doc.querySelectorAll("[data-extra]");
      for (var i = 0; i < extras.length; i++) {
        extras[i].removeAttribute("hidden");
        extras[i].removeAttribute("data-extra");
      }
      trigger.setAttribute("hidden", "");
      trigger.removeAttribute("data-reveal-extra");
    });

    // e. character hints — subtle n / max caption once a field has content
    var wireCharHint = function (field) {
      if (typeof field.addEventListener !== "function" || typeof field.insertAdjacentElement !== "function") return;
      var hint = doc.createElement("small");
      hint.setAttribute("data-char-hint", "");
      hint.setAttribute("aria-live", "polite");
      var update = function () {
        hint.textContent = field.value.length > 0 ? field.value.length + " / " + field.getAttribute("maxlength") : "";
      };
      field.addEventListener("input", update);
      update();
      field.insertAdjacentElement("afterend", hint);
    };
    if (typeof doc.querySelectorAll === "function") {
      var fields = doc.querySelectorAll('form[action="/ui/delegate"] input[maxlength]');
      for (var f = 0; f < fields.length; f++) wireCharHint(fields[f]);
    }
  };
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
`;

/** sha256 of TODAY_SCRIPT, pinned into the CSP at module load (ADR-0022). */
const TODAY_SCRIPT_SHA256 = createHash("sha256").update(TODAY_SCRIPT).digest("base64");

/**
 * ADR-0022 CSP — sent on every Today response.
 *
 * default-src 'none'  … deny-by-default fallback for every unlisted type.
 * script-src 'sha256-…' … exactly ONE inline script, pinned to its exact
 *   bytes; no 'unsafe-inline' for scripts, no 'unsafe-eval', no hosts.
 * style-src 'unsafe-inline' … the server-rendered <style> block plus the
 *   enhancement's injected <style>; no external stylesheets exist.
 * connect-src 'self' … fetch-on-focus targets location.href; without this
 *   directive the fetch falls back to default-src ('none') and is blocked
 *   SILENTLY — the enhancement would no-op with no diagnostic.
 * img-src 'self' … /ui/icon.svg favicon/apple-touch-icon; nothing external.
 * form-action 'self' … every POST targets a same-origin form endpoint.
 * base-uri 'none' … no <base> hijack of relative URLs.
 */
export const TODAY_CSP =
  `default-src 'none'; script-src 'sha256-${TODAY_SCRIPT_SHA256}'; style-src 'unsafe-inline'; ` +
  `connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'`;

/**
 * The one block Lane A's page() inserts (integration pass: one line,
 * `${scriptTags()}`, inside <head> — the current page() places it between
 * the viewport meta and the <style> block). Returns the app-identity meta +
 * icon links and the single pinned inline script.
 */
export function scriptTags(): string {
  return (
    `<meta name="apple-mobile-web-app-capable" content="yes">` +
    `<meta name="apple-mobile-web-app-title" content="Today">` +
    `<meta name="apple-mobile-web-app-status-bar-style" content="default">` +
    `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fafafa">` +
    `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1c1c1e">` +
    `<link rel="icon" href="/ui/icon.svg" type="image/svg+xml">` +
    `<link rel="apple-touch-icon" href="/ui/icon.svg">` +
    `<script>${TODAY_SCRIPT}</script>`
  );
}
