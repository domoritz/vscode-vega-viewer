'use strict';
import { 
  workspace, 
  window, 
  Disposable, 
  Uri, 
  ViewColumn, 
  WorkspaceFolder, 
  Webview,
  WebviewPanel, 
  WebviewPanelOnDidChangeViewStateEvent, 
  WebviewPanelSerializer
} from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {Logger, LogLevel} from './logger';
import {previewManager} from './preview.manager';

export class VegaPreviewSerializer implements WebviewPanelSerializer {
  constructor(private extensionPath: string, private template: string) {
  }

  async deserializeWebviewPanel(webviewPanel: WebviewPanel, state: any) {
    const logger = new Logger('vega.preview.serializer:', LogLevel.Debug); // .Info for prod
    logger.logMessage(LogLevel.Debug, 'deserializeWeviewPanel(): url:', state.uri.toString());
    previewManager.add(
      new VegaPreview(
        this.extensionPath, 
        Uri.parse(state.uri),
        webviewPanel.viewColumn, 
        this.template, 
        webviewPanel
    ));
  }
}
export class VegaPreview {
    
  protected _disposables: Disposable[] = [];
  private _extensionPath: string;
  private _uri: Uri;
  private _previewUri: Uri;
  private _fileName: string;
  private _title: string;
  private _html: string;
  private _panel: WebviewPanel;
  private _logger = new Logger('vega.preview:', LogLevel.Debug); // .Info for prod

  constructor(extensionPath: string, 
    uri: Uri, viewColumn: ViewColumn, 
    template: string, panel?: WebviewPanel) {
    this._extensionPath = extensionPath;
    this._uri = uri;
    this._fileName = path.basename(uri.fsPath);
    this._previewUri = this._uri.with({scheme: 'vega'});
    this._title = `Preview ${this._fileName} 📊`;
    const scriptsPath: string = Uri.file(path.join(this._extensionPath, 'scripts'))
      .with({scheme: 'vscode-resource'}).toString(true);
    this._html = template.replace(/\{scripts\}/g, scriptsPath);
    this._panel = panel;
    this.initWebview(viewColumn);
    this.configure();
  }

  private initWebview(viewColumn: ViewColumn): void {
    if (!this._panel) {
    // create webview panel
    this._panel = window.createWebviewPanel('vega.preview', 
      this._title, viewColumn, 
      this.getWebviewOptions());
    }

    this._panel.onDidDispose(() => {
      this.dispose();
    }, null, this._disposables);

    this._panel.onDidChangeViewState(
      (viewStateEvent: WebviewPanelOnDidChangeViewStateEvent) => {
      let active = viewStateEvent.webviewPanel.visible;
    }, null, this._disposables);

    // process web view messages
    this.webview.onDidReceiveMessage(message => {
      switch (message.command) {
        case 'refresh':
          this.refresh();
          break;
        case 'exportSvg':
          this.exportSvg(message.svg);
          break;
        case 'exportPng':
          this.exportPng(message.imageData);
          break;
      }
    }, null, this._disposables);
  } // end of initWebview()

  private getWebviewOptions(): any {
    return {
      enableScripts: true,
      enableCommandUris: true,
      retainContextWhenHidden: true,
      localResourceRoots: this.getLocalResourceRoots()
    };
  }

  private getLocalResourceRoots(): Uri[] {
    const localResourceRoots: Uri[] = [];
    const workspaceFolder: WorkspaceFolder = workspace.getWorkspaceFolder(this.uri);
    if (workspaceFolder) {
      localResourceRoots.push(workspaceFolder.uri);
    }
    else if (!this.uri.scheme || this.uri.scheme === 'file') {
      localResourceRoots.push(Uri.file(path.dirname(this.uri.fsPath)));
    }
    // add vega preview js scripts
    localResourceRoots.push(Uri.file(path.join(this._extensionPath, 'scripts')));
    this._logger.logMessage(LogLevel.Debug, 'getLocalResourceRoots():', localResourceRoots);
    return localResourceRoots;
  }

  public configure(): void {
    this.webview.html = this.html;
    // NOTE: let webview fire refresh message
    // when vega preview DOM content is initialized
    // see: this.refresh();
  }

  public refresh(): void {
    // reveal corresponding Vega preview panel
    this._panel.reveal(this._panel.viewColumn, true); // preserve focus
    // open Vega json spec text document
    workspace.openTextDocument(this.uri).then(document => {
      this._logger.logMessage(LogLevel.Debug, 'refresh(): file:', this._fileName);
      const vegaSpec: string = document.getText();
      try {
        const spec = JSON.parse(vegaSpec);
        const data = this.getData(spec);
        this.webview.postMessage({
          command: 'refresh',
          fileName: this._fileName,
          uri: this._uri.toString(),
          spec: vegaSpec,
          data: data
        });
      }
      catch (error) {
        this._logger.logMessage(LogLevel.Error, 'refresh():', error.message);
        this.webview.postMessage({error: error});
      }
    });
  }

  private getData(spec: any): any {
    const dataFiles = {};

    // get top level data urls
    let dataUrls: Array<string> = this.getDataUrls(spec);

    // add nested spec data urls for view compositions (facets, repeats, etc.)
    dataUrls = dataUrls.concat(this.getDataUrls(spec['spec']));
    this._logger.logMessage(LogLevel.Debug, 'getData(): dataUrls:', dataUrls);

    // get all local files data
    dataUrls.filter(url => !url.startsWith('http')).forEach(url => {
      // get local file data
      const fileData: string = this.getFileData(url);
      if (fileData) {
        dataFiles[url] = fileData;
      }
      this._logger.logMessage(LogLevel.Debug, 'getData(): localDataUrl:', url);
    });
    return dataFiles;
  }
  
  private getDataUrls(spec: any): Array<string> {
    let dataUrls: Array<string> = [];
    if (spec === undefined){
      return dataUrls; // base case
    }
    const data: any = spec['data'];
    const transforms: Array<any> = spec['transform'];
    let layers: Array<any> = [];
    layers = layers.concat(spec['layer']);
    layers = layers.concat(spec['concat']);
    layers = layers.concat(spec['hconcat']);
    layers = layers.concat(spec['vconcat']);
    if (data !== undefined) {
      // get top level data references
      if (Array.isArray(data)) {
        data.filter(d => d['url'] !== undefined).forEach(d => {
          dataUrls.push(d['url']);
        });
      }
      else if (data['url'] !== undefined) {
        dataUrls.push(data['url']);
      }
    }
    if (layers !== undefined && Array.isArray(layers)) {
      // get layers data references
      layers.forEach(layer => {
        dataUrls = dataUrls.concat(this.getDataUrls(layer));
      });
    }
    if (transforms !== undefined) {
      // get transform data references
      transforms.forEach(transformData => {
        dataUrls = dataUrls.concat(this.getDataUrls(transformData['from']));
      });
    }
    return dataUrls;
  }

  // TODO: change this to async later
  private getFileData(filePath: string): string {
    let data:string = null;
    const dataFilePath = path.join(path.dirname(this._uri.fsPath), filePath);
    if (fs.existsSync(dataFilePath)) {
      data = fs.readFileSync(dataFilePath, 'utf8');
    }
    else {
      this._logger.logMessage(LogLevel.Error, 'getFileData():', `${filePath} doesn't exist`);
    }
    return data;
  }

  private async exportSvg(svg: string): Promise<void> {
    const svgFilePath: string = this._uri.fsPath.replace('.json', '');
    const svgFileUri: Uri = await window.showSaveDialog({
      defaultUri: Uri.parse(svgFilePath).with({scheme: 'file'}),
      filters: {'SVG': ['svg']}
    });
    if (svgFileUri) {
      fs.writeFile(svgFileUri.fsPath, svg, (error) => {
        if (error) {
          const errorMessage: string = `Failed to save file: ${svgFileUri.fsPath}`;
          this._logger.logMessage(LogLevel.Error, 'exportSvg():', errorMessage);
          window.showErrorMessage(errorMessage);
        }
      });
    }
    this.webview.postMessage({command: 'showMessage', message: ''});
  }

  private async exportPng(imageData: string): Promise<void> {
    const base64: string = imageData.replace('data:image/png;base64,', '');
    const pngFilePath: string = this._uri.fsPath.replace('.json', '');
    const pngFileUri: Uri = await window.showSaveDialog({
      defaultUri: Uri.parse(pngFilePath).with({scheme: 'file'}),
      filters: {'PNG': ['png']}
    });
    if (pngFileUri) {
      fs.writeFile(pngFileUri.fsPath, base64, 'base64', (error) => {
        if (error) {
          const errorMessage: string = `Failed to save file: ${pngFileUri.fsPath}`;
          this._logger.logMessage(LogLevel.Error, 'exportPng():', errorMessage);
          window.showErrorMessage(errorMessage);
        }
      });
    }
    this.webview.postMessage({command: 'showMessage', message: ''});
  }

  public dispose() {
    previewManager.remove(this);
    this._panel.dispose();
    while (this._disposables.length) {
      const item = this._disposables.pop();
      if (item) {
        item.dispose();
      }
    }
  }

  get visible(): boolean {
    return this._panel.visible;
  }

  get webview(): Webview {
    return this._panel.webview;
  }
    
  get uri(): Uri {
    return this._uri;
  }

  get previewUri(): Uri {
    return this._previewUri;
  }
  
  get html(): string {
    return this._html;
  }
}
