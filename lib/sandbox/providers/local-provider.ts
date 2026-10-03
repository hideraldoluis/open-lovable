import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import nodePath from 'path';
import { SandboxProvider, SandboxInfo, CommandResult } from '../types';

/**
 * Runs the generated app directly on this machine: a folder on disk plus a
 * Vite dev server as a child process. No isolation - generated code and
 * commands run with your user's permissions.
 */
export class LocalProvider extends SandboxProvider {
  private dir = '';
  private vite: ChildProcess | null = null;
  private port = Number(process.env.LOCAL_SANDBOX_PORT || 5173);

  private resolve(p: string): string {
    // Routes sometimes pass absolute paths from the cloud providers
    const rel = p.replace(/^\/vercel\/sandbox\/?/, '').replace(/^\/home\/user\/app\/?/, '');
    const full = nodePath.resolve(this.dir, rel);
    if (full !== this.dir && !full.startsWith(this.dir + nodePath.sep)) {
      throw new Error(`Path outside sandbox: ${p}`);
    }
    return full;
  }

  private exec(cmd: string, args: string[] | null): Promise<CommandResult> {
    return new Promise((done) => {
      const child = args ? spawn(cmd, args, { cwd: this.dir }) : spawn(cmd, { cwd: this.dir, shell: true });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => (stdout += d));
      child.stderr?.on('data', (d) => (stderr += d));
      child.on('error', (e) => done({ stdout, stderr: e.message, exitCode: 1, success: false }));
      child.on('close', (code) => done({ stdout, stderr, exitCode: code ?? 1, success: code === 0 }));
    });
  }

  async createSandbox(): Promise<SandboxInfo> {
    await this.terminate();
    const sandboxId = `local-${Date.now()}`;
    const base = process.env.LOCAL_SANDBOX_DIR || nodePath.join(os.tmpdir(), 'open-lovable');
    this.dir = nodePath.resolve(base, sandboxId);
    await fs.mkdir(nodePath.join(this.dir, 'src'), { recursive: true });
    // os.tmpdir() can be an 8.3 short path on Windows; Vite compares against the real path
    this.dir = await fs.realpath(this.dir);
    this.sandbox = { dir: this.dir };

    // A few routes (get-sandbox-files, create-zip, restart-vite) talk to
    // global.activeSandbox using the Vercel SDK call shape. Give them a shim.
    (global as any).activeSandbox = {
      runCommand: async (arg: string | { cmd: string; args?: string[] }) => {
        if (typeof arg === 'string') return this.runCommand(arg);
        let r: CommandResult;
        if (arg.cmd === 'stat' && arg.args?.[0] === '-f') {
          // BSD-only syntax in get-sandbox-files; answer it portably
          try {
            const s = await fs.stat(this.resolve(arg.args[2]));
            r = { stdout: String(s.size), stderr: '', exitCode: 0, success: true };
          } catch (e: any) {
            r = { stdout: '', stderr: e.message, exitCode: 1, success: false };
          }
        } else if (arg.cmd === 'find') {
          // GNU find is not available on Windows; list source files portably
          const exts = /\.(jsx|js|tsx|ts|css|json)$/;
          const files = (await this.listFiles('.')).filter((f) => exts.test(f));
          r = { stdout: files.map((f) => `./${f}`).join('\n'), stderr: '', exitCode: 0, success: true };
        } else if (arg.cmd === 'cat') {
          try {
            r = { stdout: await this.readFile(arg.args?.[0] || ''), stderr: '', exitCode: 0, success: true };
          } catch (e: any) {
            r = { stdout: '', stderr: e.message, exitCode: 1, success: false };
          }
        } else {
          r = await this.exec(arg.cmd, arg.args || []);
        }
        return { exitCode: r.exitCode, stdout: async () => r.stdout, stderr: async () => r.stderr };
      },
      writeFile: (p: string, c: string) => this.writeFile(p, c),
      readFile: (p: string) => this.readFile(p),
      restartViteServer: () => this.restartViteServer(),
    };

    this.sandboxInfo = {
      sandboxId,
      url: `http://localhost:${this.port}`,
      provider: 'local',
      createdAt: new Date(),
    };
    return this.sandboxInfo;
  }

  async runCommand(command: string): Promise<CommandResult> {
    if (!this.sandbox) throw new Error('No active sandbox');
    // Routes use pkill to stop Vite; handle it without touching other processes
    if (/^pkill\b.*vite/.test(command.trim())) {
      this.stopVite();
      return { stdout: '', stderr: '', exitCode: 0, success: true };
    }
    // cmd.exe would create a folder literally named "-p"
    const mk = command.trim().match(/^mkdir\s+-p\s+(.+)$/);
    if (mk) {
      for (const d of mk[1].split(/\s+/)) await fs.mkdir(this.resolve(d.replace(/^["']|["']$/g, '')), { recursive: true });
      return { stdout: '', stderr: '', exitCode: 0, success: true };
    }
    return this.exec(command, null);
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (!this.sandbox) throw new Error('No active sandbox');
    const full = this.resolve(path);
    await fs.mkdir(nodePath.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }

  async readFile(path: string): Promise<string> {
    if (!this.sandbox) throw new Error('No active sandbox');
    return fs.readFile(this.resolve(path), 'utf8');
  }

  async listFiles(directory: string = '.'): Promise<string[]> {
    if (!this.sandbox) throw new Error('No active sandbox');
    const skip = new Set(['node_modules', '.git', 'dist', 'build']);
    const out: string[] = [];
    const walk = async (abs: string) => {
      for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const child = nodePath.join(abs, entry.name);
        if (entry.isDirectory()) await walk(child);
        else out.push(nodePath.relative(this.dir, child).split(nodePath.sep).join('/'));
      }
    };
    await walk(this.resolve(directory));
    return out;
  }

  async installPackages(packages: string[]): Promise<CommandResult> {
    if (!this.sandbox) throw new Error('No active sandbox');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = await this.exec(`${npm} install --legacy-peer-deps ${packages.join(' ')}`, null);
    if (result.success && process.env.AUTO_RESTART_VITE === 'true') await this.restartViteServer();
    return result;
  }

  async setupViteApp(): Promise<void> {
    if (!this.sandbox) throw new Error('No active sandbox');

    await this.writeFile('package.json', JSON.stringify({
      name: 'sandbox-app',
      version: '1.0.0',
      type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0' },
      devDependencies: {
        '@vitejs/plugin-react': '^4.0.0',
        vite: '^4.3.9',
        tailwindcss: '^3.3.0',
        postcss: '^8.4.31',
        autoprefixer: '^10.4.16',
      },
    }, null, 2));

    await this.writeFile('vite.config.js', `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { host: 'localhost', port: ${this.port}, strictPort: true, fs: { strict: false } }
})`);

    await this.writeFile('tailwind.config.js', `/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: { extend: {} },
  plugins: [],
}`);

    await this.writeFile('postcss.config.js', `export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
}`);

    await this.writeFile('index.html', `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sandbox App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>`);

    await this.writeFile('src/main.jsx', `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)`);

    await this.writeFile('src/App.jsx', `function App() {
  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
      <p className="text-lg text-gray-400">Local sandbox ready</p>
    </div>
  )
}

export default App`);

    await this.writeFile('src/index.css', `@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
  background-color: rgb(17 24 39);
}`);

    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const install = await this.exec(`${npm} install`, null);
    if (!install.success) throw new Error(`npm install failed: ${install.stderr}`);

    await this.restartViteServer();
  }

  private stopVite(): void {
    if (this.vite && this.vite.exitCode === null) this.vite.kill();
    this.vite = null;
  }

  async restartViteServer(): Promise<void> {
    if (!this.sandbox) throw new Error('No active sandbox');
    const old = this.vite;
    this.stopVite();
    if (old && old.exitCode === null) await new Promise((r) => old.once('exit', r));

    // Run Vite's entry file with node directly (no shell), so kill() works on every OS
    const viteBin = nodePath.join(this.dir, 'node_modules', 'vite', 'bin', 'vite.js');
    const child = spawn(process.execPath, [viteBin], { cwd: this.dir });
    this.vite = child;

    await new Promise<void>((ready, fail) => {
      const timer = setTimeout(() => fail(new Error('Vite did not start within 30s')), 30000);
      const onData = (d: Buffer) => {
        const text = d.toString();
        console.log('[vite]', text.trimEnd());
        if (text.includes('Local:') || text.includes('ready in')) {
          clearTimeout(timer);
          ready();
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timer);
        fail(new Error(`Vite exited with code ${code} (is port ${this.port} already in use?)`));
      });
    });
  }

  getSandboxUrl(): string | null {
    return this.sandboxInfo?.url || null;
  }

  getSandboxInfo(): SandboxInfo | null {
    return this.sandboxInfo;
  }

  async terminate(): Promise<void> {
    const old = this.vite;
    this.stopVite();
    if (old && old.exitCode === null) await new Promise((r) => old.once('exit', r));
    if ((global as any).activeSandbox && this.sandbox) (global as any).activeSandbox = null;
    this.sandbox = null;
    this.sandboxInfo = null;
  }

  isAlive(): boolean {
    return !!this.sandbox;
  }
}
