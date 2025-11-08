# Build Instructions for Z.AI Extension

## To compile the extension:

From the `extensions/zai-chat` directory, run:

```bash
cd extensions/zai-chat
npm run compile
```

This will compile the TypeScript source in `src/` to JavaScript in `out/`.

## For development (watch mode):

```bash
npm run watch
```

This will automatically recompile when you make changes to the source files.

## After compilation:

Reload VSCode (Cmd+R or Ctrl+R) to activate the extension with the latest changes.
