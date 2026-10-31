; 安装版写一个标记，程序据此把游戏库存到用户目录（卸载/升级不会丢数据）。
; 绿色版与便携版没有此标记，继续把 FlashGamerData 放在 exe 旁边。
!macro customInstall
  FileOpen $9 "$INSTDIR\installed.marker" w
  FileWrite $9 "installer"
  FileClose $9
!macroend
