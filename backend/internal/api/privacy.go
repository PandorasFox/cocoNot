package api

import "net/http"

func servePrivacyPolicy(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(privacyHTML))
}

const privacyHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — CocoNot</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #222; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 1.5rem; }
  p { margin: 0.75rem 0; }
  .updated { color: #666; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>CocoNot — Privacy Policy</h1>
<p class="updated">Last updated: March 26, 2026</p>

<h2>No data collection</h2>
<p>CocoNot does not collect, store, or transmit any personal data. We do not log requests to our server. There are no analytics, tracking pixels, or advertising SDKs.</p>

<h2>On-device processing</h2>
<p>All barcode scanning and image processing happens entirely on your device. Scanned images and barcode data never leave your phone.</p>

<h2>Network requests</h2>
<p>The only network request CocoNot makes is to download a pre-computed mapping of product SKUs to product names and coconut-content flags. This data enhances barcode scanner results and is cached locally on your device. The app is fully functional without making this request — it is entirely optional.</p>

<h2>No accounts or sign-in</h2>
<p>CocoNot does not require or support user accounts. There is nothing to sign in to and no credentials are ever collected.</p>

<h2>Contact</h2>
<p>If you have questions about this policy, you can reach us at the contact information listed on the App Store.</p>
</body>
</html>
`
