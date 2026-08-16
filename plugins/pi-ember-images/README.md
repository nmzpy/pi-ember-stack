# pi-ember-images

Clipboard and pasted-path image attachments for Pi.

- Windows clipboard images are captured through the STA PowerShell clipboard API.
- macOS clipboard images use `osascript`.
- Pasted Windows, POSIX, quoted, and relative image paths become `[image N]` placeholders.
- Submitted placeholders are replaced by native image content parts.
- The transcript renders compact inline previews through Pi TUI's public `Image` component.
- Placeholder/fallback text is rendered with the `text` token so it is readable
  in terminals (such as Windows Terminal) that cannot display inline images.
- On terminals without a supported inline-image protocol (`getCapabilities().images === null`),
  each submitted image's fallback label (`[image N: WxH]`, via the SSOT
  `format_image_fallback_label`) is rendered inside the originating user-message
  text area at that transcript position instead of a separate preview message
  (the `pi-ember-images-preview` custom message is suppressed on this path).
  Native `ImageContent` parts are still attached for the model in both paths;
  on the fallback path the label is therefore model-visible inside the user
  message, which is the accepted tradeoff for keeping the image reference at
  its transcript position on terminals that cannot render inline images.
- PNG and JPEG attachments are compressed to lossy WebP (quality 80, max 2000 px
  on any edge) when the result is smaller; GIF and WebP inputs are left unchanged.
  Any compression failure is silent and keeps the original image.

The attachment flow is adapted from the MIT-licensed `pi-paster` project:
<https://github.com/beowulf11/pi-paster>.
