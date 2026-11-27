/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in `npm run build:preview`: bundle the sample data so the built UI can be reviewed in a browser */
  readonly VITE_PREVIEW_DATA?: string;
}
