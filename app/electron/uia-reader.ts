/**
 * Windows UI Automation 屏幕元素读取 — 拿当前前景窗口的控件树。
 *
 * 实现:spawn `powershell.exe -EncodedCommand <UTF-16LE base64 of script>`,
 * PS 用 System.Windows.Automation(.NET 框架自带,Win 7+)枚举元素,输出 JSON。
 *
 * 优点:
 *  - 不需要 native module(避免 Electron rebuild)
 *  - Windows 自带 PowerShell + UIAutomation.dll,零依赖
 *  - 跨进程,不会影响 Electron 主线程
 *
 * 缺点:
 *  - PS 启动延迟 ~300ms
 *  - 仅 Windows
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

export interface ScreenElement {
  /** 控件可见名字(label / aria-label / 文本)*/
  name: string;
  /** 控件类型,如 Button / Edit / Text / TabItem */
  type: string;
  /** 屏幕坐标 + 尺寸(物理像素;高 DPI 屏可能 ≠ CSS 像素) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 嵌套深度(0 = 窗口根) */
  depth: number;
  /** 是否启用(disabled 控件 false) */
  enabled?: boolean;
  /** 已选中(checkbox / radio / tab) */
  selected?: boolean;
}

export interface ScreenSnapshot {
  /** 前景窗口标题 */
  windowTitle: string;
  /** 进程名,例:Code.exe / chrome.exe */
  processName: string;
  /** 元素列表 — 已扁平化,enabled / 不为空字符串的优先靠前 */
  elements: ScreenElement[];
  /** 总数(可能多于返回数,过滤无名/隐藏后剩多少) */
  truncated: boolean;
}

/** PowerShell 脚本 — 输出一行 JSON 到 stdout(成功)或 stderr(出错)
 *  通过环境变量 SELF_PIDS(逗号分隔)告知本应用的进程 PID,脚本会跳过这些窗口,
 *  避免读到桌宠自己。
 */
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms
  $sig = @"
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  public static extern System.IntPtr GetForegroundWindow();
  [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)]
  public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  public static extern bool IsWindowVisible(System.IntPtr hWnd);
  [System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
  public static extern int GetWindowTextLength(System.IntPtr hWnd);
  [System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
  public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  public delegate bool EnumWindowsProc(System.IntPtr hWnd, System.IntPtr lParam);
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, System.IntPtr lParam);
"@
  # Add-Type 当 $sig 含 delegate + class 时,-PassThru 返回 Type 数组,无法直接 ::Method 调用。
  # 不依赖返回值,直接用全限定类型名 [UiaPs.Win32Hlp]::xxx 调用即可。
  Add-Type -MemberDefinition $sig -Name Win32Hlp -Namespace UiaPs | Out-Null

  # 从环境变量拿到要跳过的本应用 PID 列表
  $selfPidsRaw = $env:SELF_PIDS
  $selfPids = New-Object System.Collections.Generic.HashSet[int]
  if ($selfPidsRaw) {
    foreach ($s in $selfPidsRaw -split ',') {
      $n = 0
      if ([int]::TryParse($s.Trim(), [ref]$n)) { [void]$selfPids.Add($n) }
    }
  }
  # 永远跳过当前 PowerShell 进程自己 + Windows 桌面壳
  [void]$selfPids.Add($PID)
  # 跳过桌宠自己的进程名(传入 SELF_NAMES,逗号分隔)+ 系统外壳
  $selfNamesRaw = $env:SELF_NAMES
  $selfNames = New-Object System.Collections.Generic.HashSet[string]
  if ($selfNamesRaw) {
    foreach ($n in $selfNamesRaw -split ',') {
      $t = $n.Trim()
      if ($t) { [void]$selfNames.Add($t) }
    }
  }
  $skipNames = @('explorer','ShellExperienceHost','SearchHost','SearchApp','TextInputHost','StartMenuExperienceHost')

  # 用 EnumWindows 按 z-order 找第一个"非自己 + 可见 + 有标题"的顶层窗口
  $candidate = [IntPtr]::Zero
  $candidateTitle = ''
  $candidateProc = ''
  $candidatePid = 0
  $sb = New-Object System.Text.StringBuilder 512
  $cb = [UiaPs.Win32Hlp+EnumWindowsProc]{
    param($h, $l)
    if ($script:candidate -ne [IntPtr]::Zero) { return $true }
    if (-not [UiaPs.Win32Hlp]::IsWindowVisible($h)) { return $true }
    $len = [UiaPs.Win32Hlp]::GetWindowTextLength($h)
    if ($len -le 0) { return $true }
    $sb.Length = 0
    [void]$sb.EnsureCapacity($len + 1)
    [void][UiaPs.Win32Hlp]::GetWindowText($h, $sb, $sb.Capacity)
    $title = $sb.ToString()
    if ([string]::IsNullOrWhiteSpace($title)) { return $true }
    $tpid = [uint32]0
    [void][UiaPs.Win32Hlp]::GetWindowThreadProcessId($h, [ref]$tpid)
    if ($selfPids.Contains([int]$tpid)) { return $true }
    $p = Get-Process -Id $tpid -ErrorAction SilentlyContinue
    if (-not $p) { return $true }
    if ($skipNames -contains $p.ProcessName) { return $true }
    if ($selfNames.Contains($p.ProcessName)) { return $true }
    # 找到了,记下来,后续 EnumWindows 我们已经在第一行 return $true 跳过
    $script:candidate = $h
    $script:candidateTitle = $title
    $script:candidateProc = $p.ProcessName
    $script:candidatePid = [int]$tpid
    return $true
  }
  [void][UiaPs.Win32Hlp]::EnumWindows($cb, [IntPtr]::Zero)

  if ($candidate -eq [IntPtr]::Zero) {
    # 兜底:如果 EnumWindows 没找到,退回 GetForegroundWindow 直接读(可能含桌宠自己)
    $candidate = [UiaPs.Win32Hlp]::GetForegroundWindow()
    if ($candidate -eq [IntPtr]::Zero) {
      Write-Output (ConvertTo-Json @{error='no usable foreground window'} -Compress)
      exit 0
    }
    $tpid2 = [uint32]0
    [void][UiaPs.Win32Hlp]::GetWindowThreadProcessId($candidate, [ref]$tpid2)
    $candidatePid = [int]$tpid2
    try { $candidateProc = (Get-Process -Id $tpid2 -ErrorAction SilentlyContinue).ProcessName } catch {}
  }
  $hwnd = $candidate
  $procId = $candidatePid
  $proc = $candidateProc

  $auto = [System.Windows.Automation.AutomationElement]
  $root = $auto::FromHandle($hwnd)
  if ($root -eq $null) {
    Write-Output (ConvertTo-Json @{error='cannot get AutomationElement from hwnd'} -Compress)
    exit 0
  }
  $title = $root.Current.Name

  # 用 TreeWalker.ContentViewWalker 跳过纯装饰节点(分隔线 / 容器),
  # 只要"用户视觉上能看到的"控件
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

  $list = New-Object System.Collections.Generic.List[Object]
  $maxNodes = 600
  $maxDepth = 8

  function Walk($el, $depth) {
    if ($list.Count -ge $maxNodes) { return }
    if ($depth -gt $maxDepth) { return }
    try {
      $cur = $el.Current
      $name = $cur.Name
      $ctype = $cur.LocalizedControlType
      $bounds = $cur.BoundingRectangle
      # 跳过 Off-screen / 0 尺寸
      if ($cur.IsOffscreen -eq $true) { return }
      if ($bounds.Width -le 0 -or $bounds.Height -le 0) { return }
      # 跳过完全无名的容器(只是布局节点没意义)
      $hasName = -not [string]::IsNullOrWhiteSpace($name)
      $hasContent = $hasName -or ($ctype -in @('Edit','Document','Text','Button','Hyperlink','MenuItem','TabItem'))
      if ($hasContent) {
        $obj = [ordered]@{
          name = if ($hasName) { $name } else { '' }
          type = $ctype
          x = [int]$bounds.X
          y = [int]$bounds.Y
          w = [int]$bounds.Width
          h = [int]$bounds.Height
          depth = $depth
          enabled = $cur.IsEnabled
        }
        # 选中状态(对 TabItem / RadioButton 等)
        try {
          $sp = $null
          if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp)) {
            $obj.selected = $sp.Current.IsSelected
          }
          $tp = $null
          if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) {
            $obj.selected = ($tp.Current.ToggleState -eq 'On')
          }
        } catch {}
        $list.Add($obj) | Out-Null
      }
    } catch { return }
    # 递归子节点
    try {
      $child = $walker.GetFirstChild($el)
      while ($child -ne $null -and $list.Count -lt $maxNodes) {
        Walk $child ($depth + 1)
        $child = $walker.GetNextSibling($child)
      }
    } catch {}
  }

  Walk $root 0

  $result = [ordered]@{
    windowTitle = $title
    processName = $proc
    elements = $list
    truncated = ($list.Count -ge $maxNodes)
  }
  Write-Output (ConvertTo-Json $result -Depth 6 -Compress)
} catch {
  Write-Output (ConvertTo-Json @{error = $_.Exception.Message} -Compress)
}
`;

/** 跑 PowerShell 拿屏幕元素。Windows 才能用,其它平台抛错。
 *  默认 8 秒超时(PS 启动 + UIA 遍历可能慢)。 */
export function readScreenElements(timeoutMs = 8000): Promise<ScreenSnapshot> {
  return new Promise((resolve, reject) => {
    if (os.platform() !== 'win32') {
      reject(new Error('read_screen_elements only supports Windows (uses UIAutomationClient)'));
      return;
    }
    // -EncodedCommand 接 base64-utf16le,避免引号 / 换行转义麻烦
    const enc = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    // 把本应用所有进程 PID 通过环境变量传给 PS,让它跳过桌宠自己的窗口。
    // Electron 是 main + N 个 renderer/utility 子进程,简单收集。
    const selfPids = new Set<number>();
    selfPids.add(process.pid);
    if (process.ppid) selfPids.add(process.ppid);
    try {
      // 渲染端 / GPU / utility 子进程 — 用 process 的 children 不直接可拿,
      // 但同应用名进程都跳过(EnumWindows 阶段)
      for (const proc of (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? []) {
        const p = proc as { pid?: number };
        if (typeof p.pid === 'number') selfPids.add(p.pid);
      }
    } catch {
      // ignore
    }
    // 进程名:dev 是 "electron",打包后是 process.execPath 的 basename(去 .exe)
    const selfNames = new Set<string>();
    selfNames.add('electron');
    try {
      const exe = process.execPath;
      const m = exe.match(/([^\\/]+?)(\.exe)?$/i);
      if (m && m[1]) selfNames.add(m[1]);
    } catch {
      // ignore
    }
    const env = {
      ...process.env,
      SELF_PIDS: Array.from(selfPids).join(','),
      SELF_NAMES: Array.from(selfNames).join(','),
    };
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
      { windowsHide: true, env },
    );
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error('uia powershell timed out'));
    }, timeoutMs);
    proc.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf-8');
    });
    proc.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf-8');
    });
    proc.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`powershell exit ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const json = JSON.parse(stdout.trim());
        if (json.error) {
          reject(new Error(`uia: ${json.error}`));
          return;
        }
        resolve({
          windowTitle: json.windowTitle ?? '',
          processName: json.processName ?? '',
          elements: Array.isArray(json.elements) ? json.elements : [],
          truncated: !!json.truncated,
        });
      } catch (e) {
        reject(new Error(`uia json parse failed: ${(e as Error).message}; stdout head: ${stdout.slice(0, 300)}`));
      }
    });
  });
}
