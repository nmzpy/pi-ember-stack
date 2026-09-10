#requires -Version 5.1
#
# Pi Ember Screen capture helper.
#
# Discovers top-level Windows desktop windows and captures one of them to a PNG.
# Emits a single JSON object on stdout (an array-carrying object in -List mode);
# every diagnostic goes to stderr so the caller can parse stdout unconditionally.
#
# The plugin owns argument shaping and module resolution; this script owns only
# Win32 discovery and pixel capture.

[CmdletBinding()]
param(
    [string]$Match = "",
    [long]$Hwnd = 0,
    [string]$Out = "",
    [double]$Scale = 1.0,
    [int]$MaxWidth = 0,
    [switch]$List,
    [int]$Limit = 300
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

function Write-Diag([string]$Message) {
    [Console]::Error.WriteLine($Message)
}

function Fail([string]$Message, [int]$Code = 1) {
    $payload = [ordered]@{ ok = $false; error = $Message }
    Write-Output ($payload | ConvertTo-Json -Compress)
    exit $Code
}

Add-Type -AssemblyName System.Drawing

$signature = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class EmberWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public static string Text(IntPtr hWnd) {
        int len = GetWindowTextLength(hWnd);
        if (len <= 0) { return ""; }
        StringBuilder sb = new StringBuilder(len + 1);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
}
"@

Add-Type -TypeDefinition $signature -Language CSharp

try {
    [void][EmberWin32]::SetProcessDPIAware()
} catch {
    Write-Diag "SetProcessDPIAware failed: $($_.Exception.Message)"
}

# PW_RENDERFULLCONTENT: required for DWM-composited (Qt/Chromium/Electron) windows.
$PW_RENDERFULLCONTENT = 2

$processNames = @{}

function Get-ProcessNameSafe([uint32]$ProcessId) {
    if ($processNames.ContainsKey($ProcessId)) {
        return $processNames[$ProcessId]
    }
    $name = ""
    try {
        $name = (Get-Process -Id $ProcessId -ErrorAction Stop).ProcessName
    } catch {
        $name = ""
    }
    $processNames[$ProcessId] = $name
    return $name
}

$script:found = New-Object System.Collections.ArrayList

$callback = [EmberWin32+EnumWindowsProc] {
    param([IntPtr]$hWnd, [IntPtr]$lParam)

    $rect = New-Object EmberWin32+RECT
    if (-not [EmberWin32]::GetWindowRect($hWnd, [ref]$rect)) { return $true }

    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) { return $true }

    $owner = 0
    [void][EmberWin32]::GetWindowThreadProcessId($hWnd, [ref]$owner)

    $entry = [pscustomobject]@{
        handle    = $hWnd.ToInt64()
        pid       = [int]$owner
        process   = (Get-ProcessNameSafe $owner)
        title     = [EmberWin32]::Text($hWnd)
        left      = $rect.Left
        top       = $rect.Top
        width     = $width
        height    = $height
        area      = ($width * $height)
        visible   = [EmberWin32]::IsWindowVisible($hWnd)
        minimized = [EmberWin32]::IsIconic($hWnd)
    }

    [void]$script:found.Add($entry)
    return $true
}

try {
    [void][EmberWin32]::EnumWindows($callback, [IntPtr]::Zero)
} catch {
    Fail "EnumWindows failed: $($_.Exception.Message)"
}

$windows = @($script:found | Where-Object { $_.visible -and -not $_.minimized })
$windows = @($windows | Sort-Object -Property area -Descending)

if ($List) {
    $payload = [ordered]@{
        ok      = $true
        count   = $windows.Count
        windows = @($windows | Select-Object -First $Limit)
    }
    Write-Output ($payload | ConvertTo-Json -Compress -Depth 4)
    exit 0
}

$all = @($script:found)
$target = $null
$selection = ""

if ($Hwnd -ne 0) {
    $selection = "handle=$Hwnd"
    $target = $all | Where-Object { $_.handle -eq $Hwnd } | Select-Object -First 1
    if ($null -eq $target) {
        Fail "No top-level window with handle $Hwnd."
    }
} elseif ($Match -ne "") {
    $selection = "match=$Match"
    $candidates = @($all | Where-Object {
            ($_.process -like "*$Match*") -or ($_.title -like "*$Match*")
        })
    if ($candidates.Count -eq 0) {
        Fail "No window matched '$Match'. Call window_list to see available windows."
    }
    $target = $candidates | Sort-Object -Property area -Descending | Select-Object -First 1
} else {
    $selection = "foreground"
    $foreground = [EmberWin32]::GetForegroundWindow().ToInt64()
    $target = $all | Where-Object { $_.handle -eq $foreground } | Select-Object -First 1
    if ($null -eq $target) {
        Fail "No foreground window found."
    }
}

if ($target.minimized) {
    Fail ("Window '$($target.process)' (handle $($target.handle)) is minimized; restore it before capturing.")
}

$width = [int]$target.width
$height = [int]$target.height
if ($width -le 0 -or $height -le 0) {
    Fail "Window '$($target.process)' has an empty area ($width x $height)."
}

if ([string]::IsNullOrWhiteSpace($Out)) {
    $stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
    $Out = Join-Path $env:TEMP "pi-ember-screen-$($target.process)-$stamp.png"
}

$directory = Split-Path -Parent $Out
if (-not [string]::IsNullOrWhiteSpace($directory) -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

function Test-BlankBitmap([System.Drawing.Bitmap]$Bitmap) {
    $first = $null
    $stepX = [Math]::Max(1, [int]($Bitmap.Width / 8))
    $stepY = [Math]::Max(1, [int]($Bitmap.Height / 8))
    for ($y = 0; $y -lt $Bitmap.Height; $y += $stepY) {
        for ($x = 0; $x -lt $Bitmap.Width; $x += $stepX) {
            $pixel = $Bitmap.GetPixel($x, $y).ToArgb()
            if ($null -eq $first) {
                $first = $pixel
            } elseif ($pixel -ne $first) {
                return $false
            }
        }
    }
    return $true
}

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$method = "printwindow"
$finalWidth = $width
$finalHeight = $height

try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $hdc = $graphics.GetHdc()
        try {
            $captured = [EmberWin32]::PrintWindow([IntPtr]$target.handle, $hdc, $PW_RENDERFULLCONTENT)
        } finally {
            $graphics.ReleaseHdc($hdc)
        }
    } finally {
        $graphics.Dispose()
    }

    if (-not $captured -or (Test-BlankBitmap $bitmap)) {
        Write-Diag "PrintWindow produced no usable pixels; falling back to a screen copy."
        $method = "screen-copy"
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen($target.left, $target.top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
        } finally {
            $graphics.Dispose()
        }
    }

    $scaleFactor = $Scale
    if ($scaleFactor -le 0) { $scaleFactor = 1.0 }
    if ($MaxWidth -gt 0 -and $width * $scaleFactor -gt $MaxWidth) {
        $scaleFactor = [double]$MaxWidth / [double]$width
    }

    if ($scaleFactor -lt 0.999) {
        $finalWidth = [Math]::Max(1, [int][Math]::Round($width * $scaleFactor))
        $finalHeight = [Math]::Max(1, [int][Math]::Round($height * $scaleFactor))
        $resized = New-Object System.Drawing.Bitmap($finalWidth, $finalHeight)
        $resizeGraphics = [System.Drawing.Graphics]::FromImage($resized)
        try {
            $resizeGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $resizeGraphics.DrawImage($bitmap, 0, 0, $finalWidth, $finalHeight)
        } finally {
            $resizeGraphics.Dispose()
        }
        $bitmap.Dispose()
        $bitmap = $resized
    }

    $bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
} catch {
    Fail "Capture failed: $($_.Exception.Message)"
} finally {
    if ($null -ne $bitmap) { $bitmap.Dispose() }
}

$payload = [ordered]@{
    ok            = $true
    path          = $Out
    handle        = $target.handle
    pid           = $target.pid
    process       = $target.process
    title         = $target.title
    selection     = $selection
    method        = $method
    source_width  = $width
    source_height = $height
    width         = $finalWidth
    height        = $finalHeight
    rect          = [ordered]@{
        left   = $target.left
        top    = $target.top
        width  = $width
        height = $height
    }
}

Write-Output ($payload | ConvertTo-Json -Compress -Depth 4)
exit 0
