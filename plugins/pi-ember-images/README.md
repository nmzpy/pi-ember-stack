# pi-ember-images

Clipboard and pasted-path image attachments for Pi.

- Windows clipboard images are captured through the STA PowerShell clipboard API.
- macOS clipboard images use `osascript`.
- Pasted Windows, POSIX, quoted, and relative image paths become `[image N]` placeholders.
- Submitted placeholders are replaced by native image content parts.
- The transcript renders compact inline previews through Pi TUI's public `Image` component.

The attachment flow is adapted from the MIT-licensed `pi-paster` project:
<https://github.com/beowulf11/pi-paster>.
