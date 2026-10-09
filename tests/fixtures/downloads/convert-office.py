from pathlib import Path
import win32com.client
import subprocess

processes = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout.upper()
if any(name in processes for name in ["WINWORD.EXE", "EXCEL.EXE", "POWERPNT.EXE"]):
    raise SystemExit("Close Office first: fixture conversion never attaches to user documents.")
out = Path(__file__).resolve().parent
word = win32com.client.DispatchEx("Word.Application")
try:
    word.Visible = False
    word.DisplayAlerts = 0
    doc = word.Documents.Open(str(out / "sample.docx"), ReadOnly=True, AddToRecentFiles=False, Visible=False)
    doc.RemoveDocumentInformation(99)
    try: doc.SaveAs2(str(out / "sample.doc"), FileFormat=0, AddToRecentFiles=False)
    finally: doc.Close(False)
finally: word.Quit()
print("DOC saved", flush=True)
excel = win32com.client.DispatchEx("Excel.Application")
try:
    excel.Visible = False
    excel.DisplayAlerts = False
    book = excel.Workbooks.Open(str(out / "sample.xlsx"), ReadOnly=True)
    try:
        book.RemoveDocumentInformation(99)
        book.CheckCompatibility = False
        book.SaveAs(str(out / "sample.xls"), FileFormat=56)
    finally: book.Close(False)
finally: excel.Quit()
print("XLS saved", flush=True)
ppt = win32com.client.DispatchEx("PowerPoint.Application")
try:
    doc = ppt.Presentations.Open(str(out / "sample.pptx"), ReadOnly=True, WithWindow=False)
    doc.RemoveDocumentInformation(99)
    try: doc.SaveCopyAs(str(out / "sample.ppt"), 1)
    finally: doc.Close()
finally: ppt.Quit()
print("PPT saved", flush=True)
