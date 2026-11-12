; 설치할 때 윈도우 방화벽에 ChanRemote 허용 규칙 추가 (폰에서 접속이 막히지 않게)
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ChanRemote"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="ChanRemote" dir=in action=allow program="$INSTDIR\ChanRemote.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ChanRemote"'
!macroend
