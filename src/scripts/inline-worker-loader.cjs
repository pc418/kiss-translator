/**
 * 将 Worker 模块单独编译为一个完整脚本，并以字符串形式导出其源码。
 * 油猴脚本运行在宿主页面，`new Worker(new URL(...))` 生成的 Worker chunk 会按宿主页面 URL 加载而 404，
 * 因此由调用方通过 Blob URL 启动这段源码。
 */
const path = require("path");

module.exports = function inlineWorkerLoader() {};

module.exports.pitch = function pitch() {
  const callback = this.async();
  const { webpack } = this._compiler;
  const parent = this._compilation;
  const name = `inline-worker-${path.basename(this.resourcePath, ".js")}`;
  const child = parent.createChildCompiler(
    name,
    {
      filename: `${name}.js`,
      chunkFilename: `${name}.[id].js`,
      publicPath: "",
    },
    [
      new webpack.webworker.WebWorkerTemplatePlugin(),
      new webpack.EntryPlugin(this.context, this.resourcePath, name),
      // Worker 内的动态依赖也必须留在这一个脚本里。
      new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
    ]
  );
  child.runAsChild((error, entries, compilation) => {
    if (error) return callback(error);
    // runAsChild 会把子编译产物写入父编译；源码已内联，不再单独输出。
    for (const asset of compilation.getAssets()) parent.deleteAsset(asset.name);
    for (const file of compilation.fileDependencies) this.addDependency(file);
    for (const dir of compilation.contextDependencies)
      this.addContextDependency(dir);
    if (compilation.errors.length) return callback(compilation.errors[0]);
    for (const warning of compilation.warnings) this.emitWarning(warning);
    const scripts = entries.flatMap((chunk) =>
      [...chunk.files].filter((file) => file.endsWith(".js"))
    );
    if (compilation.chunks.size !== 1 || scripts.length !== 1)
      return callback(
        new Error(`${name} must compile to one script, got ${scripts}`)
      );
    const source = compilation.getAsset(scripts[0]).source.source();
    callback(null, `export default ${JSON.stringify(String(source))};`);
  });
};
