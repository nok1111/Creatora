param([double]$x0,[double]$y0,[double]$x1,[double]$y1,[int]$steps=40)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.UI.Input.Preview.Injection.InputInjector,Windows.UI.Input.Preview.Injection,ContentType=WindowsRuntime]
$ii = [Windows.UI.Input.Preview.Injection.InputInjector]::TryCreate()
if(-not $ii){ Write-Output "no injector"; exit 1 }
$ii.InitializeMouseInjection([Windows.UI.Input.Preview.Injection.InjectedMouseVisualizationMode]::None)
$info = New-Object Windows.UI.Input.Preview.Injection.InjectedInputMouseInfo
$info.MouseOptions = [Windows.UI.Input.Preview.Injection.InjectedInputMouseOptions]::Move -bor [Windows.UI.Input.Preview.Injection.InjectedInputMouseOptions]::Absolute -bor [Windows.UI.Input.Preview.Injection.InjectedInputMouseOptions]::VirtualDesk
$norm = { param($x,$y) $info.DeltaX=[int](($x/65535)*65535); }
# move to start
$info.DeltaX=0;$info.DeltaY=0;$info.MouseData=0;$info.TimeOffsetInMilliseconds=0
$info.MouseOptions = [Windows.UI.Input.Preview.Injection.InjectedInputMouseOptions]::Move -bor [Windows.UI.Input.Preview.Injection.InjectedInputMouseOptions]::Absolute -bor [Windows.UI.Input.Preview.Injection.InjectedInputMouseOptions]::VirtualDesk
# InputInjector expects absolute coordinates in normalized? Actually pixel coords for MoveToAbsolute
$inj = { param($xx,$yy,$opt)
  $i = New-Object Windows.UI.Input.Preview.Injection.InjectedInputMouseInfo
  $i.MouseOptions = $opt -bor [Windows.UI.Input.Preview.Injection.InjectedInputMouseOptions]::MoveToAbsolute -bor [Windows.UI.Input.Preview.Injection.InjectedInputMouseOptions]::VirtualDesk
  $i.DeltaX = [int]$xx; $i.DeltaY = [int]$yy
  $ii.InjectMouseInput(@($i)) }
& $inj $x0 $y0 ([Windows.UI.Input.Preview.Injection.InjectedInputMouseOptions]::Move)
Start-Sleep -Milliseconds 150
$l = New-Object Windows.UI.Input.Preview.Injection.InjectedInputMouseInfo
$l.MouseOptions = [Windows.UI.Input.Preview.Injection.InjectedInputMouseOptions]::LeftDown
$ii.InjectMouseInput(@($l))
Start-Sleep -Milliseconds 200
for($s=1;$s -le $steps;$s++){
  $f=$s/$steps
  & $inj ($x0+($x1-$x0)*$f) ($y0+($y1-$y0)*$f) ([Windows.UI.Input.Preview.Injection.InjectedInputMouseOptions]::Move)
  Start-Sleep -Milliseconds 25
}
Start-Sleep -Milliseconds 300
$u = New-Object Windows.UI.Input.Preview.Injection.InjectedInputMouseInfo
$u.MouseOptions = [Windows.UI.Input.Preview.Injection.InjectedInputMouseOptions]::LeftUp
$ii.InjectMouseInput(@($u))
Write-Output "done"
