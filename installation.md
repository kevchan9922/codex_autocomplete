# Installation

There are 3 options for installation:

1. [Install VSIX](#option-1-install-vsix)

**For Developers**

2. [Rebuild and install the updated VSIX file (after code changes)](#option-2-rebuild-and-install-updated-vsix-after-code-changes)
3. [Setup From Source (after code changes to debug the code)](#option-3-setup-from-source-debugging)

## Option 1: Install VSIX

1. Install the VSIX from terminal:

   ```bash
   npm run package:vsix
   code --install-extension *.vsix
   ```

   Or in VS Code: Extensions panel -> `...` menu -> **Install from VSIX...**

3. Verify install:

   - Open Extensions panel and confirm `Codex Autocomplete` is installed/enabled.
   - Run `Codex Autocomplete: Login` from Command Palette.

## Option 2: Rebuild And Install Updated VSIX (After Code Changes)

1. Rebuild and reinstall:

   ```bash
   npm install
   npm run package:vsix
   code --install-extension *.vsix --force
   ```

2. Refresh VS Code from Command Palette:

   - Open Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux).
   - Run **Developer: Reload Window**.

## Option 3: Setup From Source (Debugging)

1. Install dependencies:

   ```bash
   npm install
   ```

2. Compile:

   ```bash
   npm run compile
   ```

3. Run tests:

   ```bash
   npm test
   ```

4. Launch extension in desktop VS Code:

   - Open repo in VS Code.
   - Run and Debug -> `Run Extension` (F5).

## Uninstall VSIX Extension

1. Uninstall from terminal:

   ```bash
   code --uninstall-extension kevchan99222.codex-autocomplete
   ```
2. Or uninstall in VS Code:

   - Open Extensions panel.
   - Search for `Codex Autocomplete`.
   - Click the gear icon and choose **Uninstall**.

3. Reload VS Code from Command Palette:

   - Open Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux).
   - Run **Developer: Reload Window**.
