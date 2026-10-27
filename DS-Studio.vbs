Option Explicit
Dim shell, fso, root, candidates, candidate, node, result, folder, base, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
Set candidates = CreateObject("Scripting.Dictionary")
Sub AddCandidate(value)
  If InStr(value, "%") = 0 Then candidates.Add CStr(candidates.Count), value
End Sub
Sub AddVersions(value, suffix)
  Dim parent, child
  If fso.FolderExists(value) Then
    Set parent = fso.GetFolder(value)
    For Each child In parent.SubFolders
      AddCandidate child.Path & suffix
    Next
  End If
End Sub
Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
For Each folder In Split(shell.ExpandEnvironmentStrings("%PATH%"), ";")
  If Len(folder) > 0 Then AddCandidate Replace(folder, Chr(34), "") & "\node.exe"
Next
For Each base In Array("%ProgramFiles%\nodejs\node.exe", "%LOCALAPPDATA%\Programs\nodejs\node.exe", "%APPDATA%\npm\node.exe", "%VOLTA_HOME%\bin\node.exe", "%NVM_SYMLINK%\node.exe")
  AddCandidate shell.ExpandEnvironmentStrings(base)
Next
AddVersions shell.ExpandEnvironmentStrings("%NVM_HOME%"), "\node.exe"
AddVersions shell.ExpandEnvironmentStrings("%APPDATA%\nvm"), "\node.exe"
AddVersions shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\fnm\node-versions"), "\installation\node.exe"
AddVersions shell.ExpandEnvironmentStrings("%USERPROFILE%\.local\share\mise\installs\node"), "\node.exe"
node = ""
For Each candidate In candidates.Items
  If fso.FileExists(candidate) Then
    On Error Resume Next
    result = shell.Run(Quote(candidate) & " -e " & Quote("var v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||v[0]===22&&v[1]>=12?0:1)"), 0, True)
    If Err.Number = 0 And result = 0 Then node = candidate
    Err.Clear
    On Error GoTo 0
    If Len(node) > 0 Then Exit For
  End If
Next
If Len(node) = 0 Then
  MsgBox "Installez Node.js LTS avec npm (22.12 ou superieur), puis double-cliquez de nouveau sur DS-Studio. Le guide va s'ouvrir. Aucun reglage systeme n'est modifie par le lanceur.", vbInformation, "DS-Studio"
  shell.Run Quote(root & "\launcher\INSTALLATION.html"), 1, False
  WScript.Quit 1
End If
shell.CurrentDirectory = root
result = shell.Run(Quote(node) & " " & Quote(root & "\scripts\launcher.mjs"), 0, True)
If result <> 0 Then
  MsgBox "Le lanceur n'a pas pu demarrer. Consultez le guide de depannage. Aucun processus inconnu n'a ete arrete.", vbExclamation, "DS-Studio"
  shell.Run Quote(root & "\launcher\INSTALLATION.html"), 1, False
End If
