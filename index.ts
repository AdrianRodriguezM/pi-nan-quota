// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Package entry point.
 *
 * Pi names an extension after the directory holding its entry file, so this
 * lives at the package root to surface as "pi-nan-quota" rather than "src".
 * The implementation stays in src/.
 */
export { default } from "./src/index.ts";
