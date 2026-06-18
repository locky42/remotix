# Changelog

All notable changes to this project will be documented in this file.

## [1.3.3] — 2026-06-19

### Added
* **Double-Click Connection**: Servers now open strictly via a quick double-click. Single clicks will no longer trigger accidental connections.
* **Logging Configuration**: Added an option to choose the log level (errors only or full debug) to reduce system overhead.
* **Password Field for SSH Key**: The password field remains accessible and usable even when the SSH key file connection mode is selected.

### Changed
* **Colored Logs**: Severity tags in the log terminal are now automatically highlighted according to your active VS Code theme colors.

### Fixed
* **Connection Password Saving**: Fixed an issue where a saved connection password was unavailable or not applied until the extension or app was restarted.
* **Suppressed Auto-Focus**: The Output channel panel no longer forcefully pops up on the screen during background extension operations.
* **Hidden SSH Passwords**: Passwords are no longer exposed as open arguments in `sshpass` processes, remaining safely isolated within the environment.
* **Minor UI Fixes**: Polished visual elements and minor interface alignments across the extension panel.

## [1.3.2] - 2026-05-02

### Added

- File and folder labels in the remote tree now show last modified date.
- File labels in the remote tree now show human-readable sizes (`KB`, `MB`, `GB`).

### Changed

- Archive download for SSH folders now streams `tar.gz` content directly from the remote server.

### Fixed

- Edited connections are now persisted correctly after saving.
- SSH archive downloads no longer fail on non-fatal tar warnings such as "file changed as we read it".

## [1.3.1] - 2026-05-02

### Added

- Download folder as archive (tar.gz) directly from the remote tree.
- Error notifications for failed SSH/FTP connections with descriptive messages.

### Changed

- Code optimizations across file operation handlers.

## [1.3.0] - 2026-04-28

### Added

- Manual drag-and-drop sorting for connections in the list.
- File/folder properties dialog (info window).
- Change permissions (chmod) for SSH/FTP, including recursive mode.
- Permission icons for SSH.
- View and copy connection password.

### Changed

- Connection passwords are now migrated to Secret Storage for improved security.

### Fixed

- Tree refresh after FileZilla import.
- Duplicate connection detection and prevention during import.

## [1.2.0] - 2026-04-27

### Changed

- The SSH/FTP connection tree now renders the full path (breadcrumbs) from root to the target folder.

- Each path segment is rendered as a separate tree node; only the final folder triggers a server request.

- The root node no longer triggers a server request, creating only the first child node of the path.

- Improved UX for navigating nested folders without unnecessary server requests.

- Updated icons.

- Fixed syntax and stability issues in tree rendering logic.

## [1.1.0] - 2026-04-06

### Added

- Full remote copy workflow for SSH/FTP items (`Copy`/`Paste`).
- Paste support from system clipboard (including plain-text paths).
- Progress UI for copy operations with elapsed time.
- FTP copy status updates in the status bar.

### Changed

- Tree opening behavior: added full connection tree rendering.

### Fixed

- `remotix.copyPath` command registration and execution (`command not found` issue).
- Persistent FTP copy status display during recursive transfers.

## [1.0.0] - 2026-04-05

### Added

- Marketplace keywords in extension manifest.
- README refresh with current feature set and screenshots.
- Improved FTP listing name normalization for safer tree rendering.
- FTP upload traversal safeguards for symbolic links and local directory cycles.
- Timeout protection inside FTP recursive delete fallback operations.

### Changed

- Marketplace metadata updates in manifest (`homepage`, `bugs`, `icon`).
- Category kept as `Other` for correct Marketplace classification.

## [0.1.0] - 2026-04-05

### Added

- Initial public release of Remotix.
- SSH and FTP connection management.
- Remote file tree browsing and file operations.
- Upload/download support and inline tree actions.
- English and Ukrainian localization.
