// The userscript runs on arbitrary host pages, where a separate worker chunk would
// be fetched from the host and 404. The worker is compiled into this bundle instead.
// eslint-disable-next-line import/no-webpack-loader-syntax
import source from "!!../scripts/inline-worker-loader.cjs!./scriptWorker.js";

let url;

export const createProviderWorker = () => {
  url ||= URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  return new Worker(url);
};
