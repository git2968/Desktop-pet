# 一次性补全 app/live2d 下所有 model3.json 的 FileReferences:
#   - 把同目录(及一层子目录)的 *.motion3.json 加到 Motions(每文件一组,group 名 = 文件 stem)
#   - 把同目录(及一层子目录)的 *.exp3.json 加到 Expressions(Name = 文件 stem)
# 已存在的引用保留;新引用追加。
# 用法:在 app/ 目录下 powershell -ExecutionPolicy Bypass -File scripts/patch-model3.ps1

$root = Resolve-Path (Join-Path $PSScriptRoot '..\live2d')
Write-Host "scanning $root"

function Get-RelPath($abs, $base) {
    $rel = $abs.Substring($base.Length) -replace '^[\\/]+', ''
    return $rel -replace '\\', '/'
}

Get-ChildItem -Path $root -Recurse -Filter '*.model3.json' | ForEach-Object {
    $modelFile = $_.FullName
    $modelDir = Split-Path -Parent $modelFile
    Write-Host "`n[model] $modelFile"

    # 读 JSON(UTF-8 无 BOM)
    $bytes = [System.IO.File]::ReadAllBytes($modelFile)
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    $model = $text | ConvertFrom-Json

    if (-not $model.FileReferences) { Write-Host '  no FileReferences, skip'; return }

    # 收集同目录 + 一层子目录里的 motion / expression 文件,得到相对 modelDir 的路径
    # 用 .NET API GetFiles(同步、立即返回数组),避开 PS Get-ChildItem 诡异行为
    $allPaths = [System.IO.Directory]::GetFiles($modelDir, '*', [System.IO.SearchOption]::AllDirectories)
    Write-Host "  total files: $($allPaths.Length)"
    $motionFiles = @($allPaths | Where-Object { $_ -like '*.motion3.json' })
    $expFiles = @($allPaths | Where-Object { $_ -like '*.exp3.json' })
    Write-Host "  scan: motions=$($motionFiles.Count) expressions=$($expFiles.Count)"

    # ---------------- Motions ----------------
    $existingMotions = @{}
    if ($model.FileReferences.PSObject.Properties.Name -contains 'Motions' -and $model.FileReferences.Motions) {
        foreach ($prop in $model.FileReferences.Motions.PSObject.Properties) {
            # 过滤掉 File 为空 / 不存在的脏数据(之前脚本 bug 残留)
            $clean = @($prop.Value | Where-Object { $_.File -and $_.File -ne '' })
            if ($clean.Count -gt 0) { $existingMotions[$prop.Name] = $clean }
        }
    }

    $existingMotionFiles = @{}
    foreach ($g in $existingMotions.Keys) {
        foreach ($it in $existingMotions[$g]) { $existingMotionFiles[$it.File] = $true }
    }

    foreach ($mf in $motionFiles) {
        $rel = Get-RelPath $mf $modelDir
        if ($existingMotionFiles.ContainsKey($rel)) { continue }
        $name = [System.IO.Path]::GetFileName($mf)
        $stem = [System.IO.Path]::GetFileNameWithoutExtension($name) -replace '\.motion3$', ''
        if (-not $existingMotions.ContainsKey($stem)) { $existingMotions[$stem] = @() }
        $existingMotions[$stem] += [pscustomobject]@{ File = $rel }
        Write-Host "  + motion group '$stem' <- $rel"
    }

    if ($existingMotions.Count -gt 0) {
        $motionsObj = [pscustomobject]@{}
        foreach ($k in $existingMotions.Keys | Sort-Object) {
            $motionsObj | Add-Member -NotePropertyName $k -NotePropertyValue $existingMotions[$k]
        }
        $model.FileReferences | Add-Member -Force -NotePropertyName Motions -NotePropertyValue $motionsObj
    }

    # ---------------- Expressions ----------------
    $existingExpressions = @()
    if ($model.FileReferences.PSObject.Properties.Name -contains 'Expressions' -and $model.FileReferences.Expressions) {
        # 同样过滤空 File 脏数据
        $existingExpressions = @($model.FileReferences.Expressions | Where-Object { $_.File -and $_.File -ne '' })
    }
    $existingExpFiles = @{}
    foreach ($e in $existingExpressions) { $existingExpFiles[$e.File] = $true }

    foreach ($ef in $expFiles) {
        $rel = Get-RelPath $ef $modelDir
        if ($existingExpFiles.ContainsKey($rel)) { continue }
        $name = [System.IO.Path]::GetFileName($ef)
        $stem = [System.IO.Path]::GetFileNameWithoutExtension($name) -replace '\.exp3$', ''
        $existingExpressions += [pscustomobject]@{ Name = $stem; File = $rel }
        Write-Host "  + expression '$stem' <- $rel"
    }

    if ($existingExpressions.Count -gt 0) {
        $model.FileReferences | Add-Member -Force -NotePropertyName Expressions -NotePropertyValue $existingExpressions
    }

    # ---------------- 写回 ----------------
    $json = $model | ConvertTo-Json -Depth 32
    [System.IO.File]::WriteAllText($modelFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host "`nDone."
