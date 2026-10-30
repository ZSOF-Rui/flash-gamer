Add-Type -AssemblyName System.Drawing

$srcPath = Join-Path $PSScriptRoot '..\build\icon-source.png'
$src = [System.Drawing.Image]::FromFile((Resolve-Path $srcPath))
$size = 1024
$bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$r = 200
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
$path.AddArc($size - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
$path.AddArc($size - 2 * $r, $size - 2 * $r, 2 * $r, 2 * $r, 0, 90)
$path.AddArc(0, $size - 2 * $r, 2 * $r, 2 * $r, 90, 90)
$path.CloseFigure()
$g.SetClip($path)
$g.DrawImage($src, 0, 0, $size, $size)
$g.Dispose()

$outDir = Join-Path $PSScriptRoot '..\build'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$bmp.Save((Join-Path $outDir 'icon-1024.png'), [System.Drawing.Imaging.ImageFormat]::Png)

$icon256 = New-Object System.Drawing.Bitmap 256, 256, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g2 = [System.Drawing.Graphics]::FromImage($icon256)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, 256, 256)
$g2.Dispose()
$icon256.Save((Join-Path $PSScriptRoot '..\src\renderer\icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$icon256.Save((Join-Path $outDir 'icon-256.png'), [System.Drawing.Imaging.ImageFormat]::Png)

$bmp.Dispose()
$icon256.Dispose()
$src.Dispose()
Write-Output 'ICON_OK'
