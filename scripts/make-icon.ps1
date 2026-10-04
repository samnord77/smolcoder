# Builds build/icon.ico for the Windows package.
# Brand colors come from src/web/styles.ts (--bg, --accent) so the icon can
# never drift from the UI. Run: powershell -File scripts/make-icon.ps1

param(
  [string]$Out = (Join-Path (Split-Path $PSScriptRoot -Parent) "build\icon.ico")
)

Add-Type -AssemblyName System.Drawing

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngBlobs = New-Object System.Collections.Generic.List[byte[]]

function New-RoundedPath([System.Drawing.RectangleF]$r, [float]$rad) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $rad * 2
  $p.AddArc($r.X, $r.Y, $d, $d, 180, 90)
  $p.AddArc($r.Right - $d, $r.Y, $d, $d, 270, 90)
  $p.AddArc($r.Right - $d, $r.Bottom - $d, $d, $d, 0, 90)
  $p.AddArc($r.X, $r.Bottom - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [float]($s * 0.05)
  $rect = New-Object System.Drawing.RectangleF($pad, $pad, ($s - 2 * $pad), ($s - 2 * $pad))
  $path = New-RoundedPath $rect ([float]($s * 0.24))

  $bgTop = [System.Drawing.Color]::FromArgb(255, 0x13, 0x19, 0x22)
  $bgBottom = [System.Drawing.Color]::FromArgb(255, 0x08, 0x0c, 0x10)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect, $bgTop, $bgBottom, [float]45)
  $g.FillPath($brush, $path)

  $accent = [System.Drawing.Color]::FromArgb(255, 0x38, 0xbd, 0xf8)
  $edge = New-Object System.Drawing.Pen(
    ([System.Drawing.Color]::FromArgb(120, 0x38, 0xbd, 0xf8)), ([float]([math]::Max(1, $s * 0.035))))
  $g.DrawPath($edge, $path)

  $stroke = New-Object System.Drawing.Pen($accent, ([float]($s * 0.14)))
  $stroke.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $stroke.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $stroke.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawLine($stroke, ($s * 0.33), ($s * 0.33), ($s * 0.60), ($s * 0.50))
  $g.DrawLine($stroke, ($s * 0.60), ($s * 0.50), ($s * 0.33), ($s * 0.67))
  $g.DrawLine($stroke, ($s * 0.47), ($s * 0.71), ($s * 0.73), ($s * 0.71))

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBlobs.Add($ms.ToArray())

  $g.Dispose()
  $bmp.Dispose()
  $ms.Dispose()
}

$outDir = Split-Path $Out -Parent
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$fs = [System.IO.File]::Create($Out)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$sizes.Count)

$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dim = if ($sizes[$i] -ge 256) { [byte]0 } else { [byte]$sizes[$i] }
  $bw.Write($dim)
  $bw.Write($dim)
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]$pngBlobs[$i].Length)
  $bw.Write([uint32]$offset)
  $offset += $pngBlobs[$i].Length
}
foreach ($b in $pngBlobs) { $bw.Write($b) }
$bw.Flush()
$fs.Close()

Write-Output "icone ecrite: $Out ($($sizes.Count) tailles)"
