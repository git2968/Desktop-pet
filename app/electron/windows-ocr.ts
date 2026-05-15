/**
 * Windows 内置 OCR — 截屏 + 调用 Windows.Media.Ocr (WinRT) 识别中英文。
 *
 * 0 额外依赖 / 0 网络 / 完全本地 / 中英文识别质量好。
 * 仅 Windows 10+ 可用(98% 桌宠用户都是)。
 *
 * 实现:spawn 一段嵌入的 PowerShell:
 *   1) System.Drawing 截当前主屏 → temp PNG
 *   2) WinRT BitmapDecoder + OcrEngine.TryCreateFromUserProfileLanguages → OCR
 *   3) 输出整页文本到 stdout(UTF-8)
 *
 * 整段脚本通过 -EncodedCommand(base64-utf16le)传入,避免引号转义和编码问题。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/** 内嵌 PowerShell 脚本:截屏 + OCR,把识别文本输出到 stdout。
 *  失败时把错误信息写到 stderr(主进程会一起捕获)。 */
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# === 1. 截屏 ===
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$tempPath = Join-Path $env:TEMP ('pet-ocr-' + [guid]::NewGuid() + '.png')
$bitmap.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

# === 2. WinRT OCR ===
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

# 通用 Await — 把 WinRT IAsyncOperation<T> 等成同步 .NET Task<T>
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tempPath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

# 优先创建中文 OCR 引擎(用户系统是中文环境时更准),失败回落用户语言
$engine = $null
try {
  $zh = New-Object Windows.Globalization.Language 'zh-CN'
  if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($zh)) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($zh)
  }
} catch {}
if ($null -eq $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if ($null -eq $engine) {
  Write-Error 'No OCR engine available; please install Windows OCR language pack.'
  exit 1
}

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

# 输出整页文本(行间用换行分隔)
$lines = $result.Lines | ForEach-Object { $_.Text }
$text = ($lines -join "\`n")
[Console]::Out.Write($text)

# === 3. 清理 ===
$stream.Dispose()
Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
`;

/** 执行 OCR,返回识别到的文字。
 *  - timeoutMs:超时(默认 12 秒)
 *  - 截图最大尺寸由屏幕分辨率决定,4K 屏需要更长时间
 *
 *  返回值:
 *    text — 全部行文字(用 \n 分隔)。空字符串表示什么都没识别到。
 *  失败抛 Error,调用方决定要不要 catch。 */
export async function captureScreenAndOcr(timeoutMs = 12000): Promise<{ text: string }> {
  if (process.platform !== 'win32') {
    throw new Error('Windows OCR is only available on Windows 10+');
  }
  return new Promise((resolve, reject) => {
    // 写脚本到临时文件 — EncodedCommand 在某些 PowerShell 7.x 上对 here-string 处理不稳定,
    // 直接 -File 跑文件最稳。
    const psFile = path.join(os.tmpdir(), `pet-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
    try {
      fs.writeFileSync(psFile, PS_SCRIPT, 'utf-8');
    } catch (e) {
      reject(new Error(`Failed to write OCR script: ${(e as Error).message}`));
      return;
    }

    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      { windowsHide: true },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on('data', (b: Buffer) => stdoutChunks.push(b));
    proc.stderr.on('data', (b: Buffer) => stderrChunks.push(b));

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      reject(new Error(`Windows OCR timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      fs.unlink(psFile, () => {});
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      fs.unlink(psFile, () => {});
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (code !== 0) {
        reject(new Error(`OCR script exited ${code}: ${stderr.trim() || '(no stderr)'}`));
        return;
      }
      resolve({ text: stdout.trim() });
    });
  });
}
