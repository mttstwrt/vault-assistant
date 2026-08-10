import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores } from 'eslint/config';

export default tseslint.config(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			// This rule mangles technical strings (e.g. it wants to capitalise
			// "http://" into "HTTP://"), so it is unreliable for settings copy
			// that contains URLs and example paths.
			'obsidianmd/ui/sentence-case': 'off',
		},
	},
	{
		// Streaming needs `fetch`: Obsidian's requestUrl buffers the whole
		// response, so it can neither report tokens as they arrive nor be
		// aborted mid-answer. The agent falls back to requestUrl (see
		// src/api/client.ts) whenever a stream cannot be opened.
		files: ['src/api/stream.ts'],
		rules: {
			'no-restricted-globals': 'off',
		},
	},
	{
		// The MCP stdio transport and the Claude Code importer are desktop-only
		// and deliberately use Node's builtins and process/Buffer globals
		// (guarded by Platform.isDesktopApp).
		files: ['src/mcp/transport.ts', 'src/import/claude-code.ts'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			'import/no-nodejs-modules': 'off',
		},
	},
);
