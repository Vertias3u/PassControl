# vhs budget.tape  →  budget.gif
# Sleep is wall-clock: it must outlast the script or the recording cuts mid-run.
# These durations assume a warm gateway. Add time if yours is cold.
Output budget.gif
Set FontSize 18
Set Width 1000
Set Height 640
Set Theme "Catppuccin Mocha"
Set Padding 20
Type "./budget-demo.sh"
Enter
Sleep 26s
