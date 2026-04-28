# Changelog

All notable changes to this project will be documented in this file.

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
