# vhs receipt.tape  →  receipt.gif
# Sleep is wall-clock: it must outlast the script or the recording cuts mid-run.
# These durations assume a warm gateway. Add time if yours is cold.
Output receipt.gif
Set FontSize 18
Set Width 1000
Set Height 640
Set Theme "Catppuccin Mocha"
Set Padding 20
Type "./receipt-demo.sh"
Enter
Sleep 34s
