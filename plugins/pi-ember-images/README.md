# pi-ember-images

Clipboard and pasted-path image attachments for Pi.

- Windows clipboard images are captured through the STA PowerShell clipboard API.
- macOS clipboard images use `osascript`.
- Pasted Windows, POSIX, quoted, and relative image paths become `[image N]` placeholders.
- Submitted placeholders are replaced by native image content parts.
- The transcript renders compact inline previews through Pi TUI's public `Image` component.
- Placeholder/fallback text is rendered with the `text` token so it is readable
  in terminals (such as Windows Terminal) that cannot display inline images.
- PNG and JPEG attachments are compressed to lossy WebP (quality 80, max 2000 px
  on any edge) when the result is smaller; GIF and WebP inputs are left unchanged.
  Any compression failure is silent and keeps the original image.

The attachment flow is adapted from the MIT-licensed `pi-paster` project:
<https://github.com/beowulf11/pi-paster>.
