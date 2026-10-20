; Branded assisted installer. English interface; all users selected by default.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to NASSCAD MEDUSA 4.7.0"
  !define MUI_WELCOMEPAGE_TEXT "Create and explore 3D models on your computer.$\r$\n$\r$\nNASSCAD includes the MEDUSA native engine and its dependencies. MEDUSA starts with NASSCAD and closes when you exit.$\r$\n$\r$\nThe desktop edition works offline and uses an internal connection to MEDUSA.$\r$\n$\r$\nSetup defaults to all users of this computer. You can choose the installation folder.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend
!define MUI_FINISHPAGE_TEXT "NASSCAD and its integrated MEDUSA engine are ready.$\r$\n$\r$\nOpen NASSCAD from the desktop or Start menu. MEDUSA starts and stops automatically with the application.$\r$\n$\r$\nClick Finish to close Setup."
