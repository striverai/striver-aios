$filePath = 'C:\Users\admin\.claude\projects\D--Project-Javis-OS\c2897e11-53b7-4214-872b-efdb594017e3\tool-results\mcp-claude_ai_Meta_Facebook_Ads-ads_get_ad_entities-1782671706690.txt'
$content = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::UTF8)
$outer = $content | ConvertFrom-Json
$entities = $outer.ad_entities | ConvertFrom-Json
Write-Output ("Total entities: " + $entities.Count)

# Show unique amount_spent values sample to understand the format
$uniqueSamples = $entities | Select-Object -ExpandProperty amount_spent | Sort-Object -Unique | Select-Object -First 20
Write-Output "--- Sample amount_spent values ---"
foreach ($s in $uniqueSamples) {
    Write-Output ("  [" + $s + "]")
}
