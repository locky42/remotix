# Remotix

Remotix is a VS Code sidebar extension for working with remote servers over SSH and FTP without leaving the editor. You can manage connections, browse remote files, upload and download folders, edit files directly from VS Code, and open an SSH terminal from the same panel.

## Features

- Manage SSH and FTP connections from a single sidebar view
- Import saved hosts from SSH config and FileZilla
- Add, edit, delete, refresh, and close connections
- Browse remote directories and files in a tree view
- Create files and folders on remote servers
- Rename and delete remote files and folders
- Upload files or whole folders to SSH and FTP targets
- Download files or whole folders from SSH and FTP targets
- Edit remote files directly in VS Code
- Open an SSH terminal for SSH connections
- Use English or Ukrainian UI language
- Tune transfer concurrency in settings

## How To Use

1. Open the Remotix view from the Activity Bar.
2. Click `Add Connection` or use `More Actions` to import existing hosts.
3. Expand a connection to browse remote files and folders.
4. Use the context menu or inline actions to upload, download, edit, rename, create, refresh, or delete items.
5. For SSH connections, open a terminal directly from the same tree item.

## Settings

Remotix currently exposes these settings:

- `remotix.language`: UI language selection (`auto`, `en`, `uk`)
- `remotix.ftpDownloadConcurrency`: concurrent FTP download workers
- `remotix.ftpUploadConcurrency`: concurrent FTP upload workers
- `remotix.sshDownloadConcurrency`: concurrent SSH download workers
- `remotix.sshUploadConcurrency`: concurrent SSH upload workers

## Screenshots

Current screenshots from `media/screenshots`:

![Panel overview](media/screenshots/panel-overview.png)

Connection list and Remotix panel entry point.

![Context menu actions](media/screenshots/context-menu.png)

File and folder actions from the tree context menu.

![Remote file in editor](media/screenshots/edit-file.png)

Remote file opened directly in VS Code.

## License

MIT
