import { join, resolve, dirname, basename } from 'path';
import { copy, existsSync, mkdirpSync, symlinkSync, copySync, move, removeSync } from 'fs-p';
import globby from 'globby';

const SERVERLESS_FOLDER = '.serverless';
const BUILD_FOLDER = '.build';

const SUPPORTED_PROVIDERS = ['aws'];
const SUPPORTED_RUNTIMES = ['nodejs6.10', // @todo deprecated, remove
'nodejs8.10', // @todo deprecated, remove
'nodejs10.x', 'nodejs12.x'];

const INCLUDES = ['node_modules/@serverless-chrome/lambda/package.json', 'node_modules/@serverless-chrome/lambda/dist/bundle.cjs.js', 'node_modules/@serverless-chrome/lambda/dist/headless-chromium'];

function throwIfUnsupportedProvider(provider) {
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new Error('The "serverless-plugin-chrome" plugin currently only supports AWS Lambda. ' + `Your service is using the "${provider}" provider.`);
  }
}

function throwIfUnsupportedRuntime(runtime) {
  if (!SUPPORTED_RUNTIMES.includes(runtime)) {
    throw new Error('The "serverless-plugin-chrome" plugin only supports the Node.js 6.10 or 8.10 runtimes. ' + `Your service is using the "${runtime}" provider.`);
  }
}

function throwIfWrongPluginOrder(plugins) {
  const comesBefore = ['serverless-plugin-typescript'];
  const comesAfter = ['serverless-webpack'];

  const ourIndex = plugins.indexOf('serverless-plugin-chrome');

  plugins.forEach((plugin, index) => {
    if (comesBefore.includes(plugin) && ourIndex < index) {
      throw new Error(`The plugin "${plugin}" should appear before the "serverless-plugin-chrome"` + ' plugin in the plugin configuration section of serverless.yml.');
    }

    if (comesAfter.includes(plugin) && ourIndex > index) {
      throw new Error(`The plugin "${plugin}" should appear after the "serverless-plugin-chrome"` + ' plugin in the plugin configuration section of serverless.yml.');
    }
  });
}

function getHandlerFileAndExportName(handler = '') {
  const fileParts = handler.split('.');
  const exportName = fileParts.pop();
  const file = fileParts.join('.');

  return {
    filePath: dirname(file),
    fileName: `${basename(file)}.js`, // is it OK to assume .js?
    exportName
  };
}

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve$$1, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve$$1(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

const wrapperTemplateMap = {
  'aws-nodejs6.10': 'wrapper-aws-nodejs.js',
  'aws-nodejs8.10': 'wrapper-aws-nodejs.js',
  'aws-nodejs10.x': 'wrapper-aws-nodejs.js',
  'aws-nodejs12.x': 'wrapper-aws-nodejs.js'
};

class ServerlessChrome {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    const {
      provider: { name: providerName, runtime },
      plugins: { modules: plugins }
    } = serverless.service;

    throwIfUnsupportedProvider(providerName);
    throwIfUnsupportedRuntime(runtime);
    throwIfWrongPluginOrder(plugins);

    this.hooks = {
      'before:offline:start:init': this.beforeCreateDeploymentArtifacts.bind(this),
      'before:package:createDeploymentArtifacts': this.beforeCreateDeploymentArtifacts.bind(this),
      'after:package:createDeploymentArtifacts': this.afterCreateDeploymentArtifacts.bind(this),
      'before:invoke:local:invoke': this.beforeCreateDeploymentArtifacts.bind(this),
      'after:invoke:local:invoke': this.cleanup.bind(this),

      'before:webpack:package:packExternalModules': this.webpackPackageBinaries.bind(this)

      // only mess with the service path if we're not already known to be within a .build folder
    };this.messWithServicePath = !plugins.includes('serverless-plugin-typescript');

    // annoyingly we have to do stuff differently if using serverless-webpack plugin. lame.
    this.webpack = plugins.includes('serverless-webpack');
  }

  webpackPackageBinaries() {
    var _this = this;

    return _asyncToGenerator(function* () {
      const { config: { servicePath }, service } = _this.serverless;
      const packagedIdividually = service.package && service.package.individually;

      if (packagedIdividually) {
        const functionsToCopyTo = service.custom && service.custom.chrome && service.custom.chrome.functions || service.getAllFunctions();

        yield Promise.all(functionsToCopyTo.map((() => {
          var _ref = _asyncToGenerator(function* (functionName) {
            yield copy(join(servicePath, 'node_modules/@serverless-chrome/lambda/dist/headless-chromium'), resolve(servicePath, `.webpack/${functionName}/headless-chromium`));
          });

          return function (_x) {
            return _ref.apply(this, arguments);
          };
        })()));
      } else {
        yield copy(join(servicePath, 'node_modules/@serverless-chrome/lambda/dist/headless-chromium'), resolve(servicePath, '.webpack/service/headless-chromium'));
      }
    })();
  }

  beforeCreateDeploymentArtifacts() {
    var _this2 = this;

    return _asyncToGenerator(function* () {
      const {
        config,
        cli,
        utils,
        service,
        service: {
          provider: { name: providerName, runtime }
        }
      } = _this2.serverless;

      const functionsToWrap = service.custom && service.custom.chrome && service.custom.chrome.functions || service.getAllFunctions();

      service.package.include = service.package.include || [];

      cli.log('Injecting Headless Chrome...');

      // Save original service path and functions
      _this2.originalServicePath = config.servicePath;

      // Fake service path so that serverless will know what to zip
      // Unless, we're already in a .build folder from another plugin
      if (_this2.messWithServicePath) {
        config.servicePath = join(_this2.originalServicePath, BUILD_FOLDER);

        if (!existsSync(config.servicePath)) {
          mkdirpSync(config.servicePath);
        }

        // include node_modules into build
        if (!existsSync(resolve(join(BUILD_FOLDER, 'node_modules')))) {
          symlinkSync(resolve('node_modules'), resolve(join(BUILD_FOLDER, 'node_modules')), 'junction');
        }

        // include any "extras" from the "include" section
        const files = yield globby([...service.package.include, '**', '!node_modules/**'], {
          cwd: _this2.originalServicePath
        });

        files.forEach(function (filename) {
          const sourceFile = resolve(join(_this2.originalServicePath, filename));
          const destFileName = resolve(join(config.servicePath, filename));

          const dirname$$1 = dirname(destFileName);

          if (!existsSync(dirname$$1)) {
            mkdirpSync(dirname$$1);
          }

          if (!existsSync(destFileName)) {
            copySync(sourceFile, destFileName);
          }
        });
      }

      // Add our node_modules dependencies to the package includes
      service.package.include = [...service.package.include, ...INCLUDES];

      yield Promise.all(functionsToWrap.map((() => {
        var _ref2 = _asyncToGenerator(function* (functionName) {
          const { handler } = service.getFunction(functionName);
          const { filePath, fileName, exportName } = getHandlerFileAndExportName(handler);
          const handlerCodePath = join(config.servicePath, filePath);

          const originalFileRenamed = `${utils.generateShortId()}___${fileName}`;

          const customPluginOptions = service.custom && service.custom.chrome || {};

          const launcherOptions = _extends({
            chromePath: _this2.webpack && !process.env.IS_LOCAL ? '/var/task/headless-chromium' : undefined
          }, customPluginOptions, {
            flags: customPluginOptions.flags || []

            // Read in the wrapper handler code template
          });const wrapperTemplate = yield utils.readFile(resolve(__dirname, '..', 'src', wrapperTemplateMap[`${providerName}-${runtime}`]));

          // Include the original handler via require
          const wrapperCode = wrapperTemplate.replace("'REPLACE_WITH_HANDLER_REQUIRE'", `require('./${originalFileRenamed}')`).replace("'REPLACE_WITH_OPTIONS'", JSON.stringify(launcherOptions)).replace(/REPLACE_WITH_EXPORT_NAME/gm, exportName);

          // Move the original handler's file aside
          yield move(resolve(handlerCodePath, fileName), resolve(handlerCodePath, originalFileRenamed));

          // Write the wrapper code to the function's handler path
          yield utils.writeFile(resolve(handlerCodePath, fileName), wrapperCode);
        });

        return function (_x2) {
          return _ref2.apply(this, arguments);
        };
      })()));
    })();
  }

  afterCreateDeploymentArtifacts() {
    var _this3 = this;

    return _asyncToGenerator(function* () {
      if (_this3.messWithServicePath) {
        // Copy .build to .serverless
        yield copy(join(_this3.originalServicePath, BUILD_FOLDER, SERVERLESS_FOLDER), join(_this3.originalServicePath, SERVERLESS_FOLDER));

        // this.serverless.service.package.artifact = path.join(
        //   this.originalServicePath,
        //   SERVERLESS_FOLDER
        //   path.basename(this.serverless.service.package.artifact)
        // )

        // Cleanup after everything is copied
        yield _this3.cleanup();
      }
    })();
  }

  cleanup() {
    var _this4 = this;

    return _asyncToGenerator(function* () {
      // Restore service path
      _this4.serverless.config.servicePath = _this4.originalServicePath;

      // Remove temp build folder
      removeSync(join(_this4.originalServicePath, BUILD_FOLDER));
    })();
  }
}

export default ServerlessChrome;
//# sourceMappingURL=index.es.js.map
