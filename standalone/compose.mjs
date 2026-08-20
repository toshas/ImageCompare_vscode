/**
 * Composes the standalone page: ONE self-contained .html with the real webview shell,
 * the real webview bundle and the adapter bundle inlined — no sidecar files, and no
 * network refs beyond the adapter's lazy pptxgenjs CDN load
 * (docs/standalone.md: standalone-single-file).
 */

// A literal `</script>` inside an inlined bundle would end the tag; escaping is bytewise-neutral for JS.
function inlineScript(js) {
  return js.replace(/<\/script/gi, '<\\/script');
}

// A sourceMappingURL comment is a dangling sidecar reference once inlined — strip it.
function stripSourceMapRef(js) {
  return js.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
}

export function composeStandaloneHtml({ styles, body, adapterJs, webviewJs, version }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ImageCompare ${version}</title>
<style>
${styles}
</style>
</head>
<body>
${body}
<script>
${inlineScript(stripSourceMapRef(adapterJs))}
</script>
<script>
${inlineScript(stripSourceMapRef(webviewJs))}
</script>
</body>
</html>`;
}
