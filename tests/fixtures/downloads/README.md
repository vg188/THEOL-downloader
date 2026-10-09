# 下载完整性样本

这些文件全部由本地程序生成，只含固定的合成文本、表格和图片，不含课程资料、账号、Cookie 或个人文档。测试直接读取文件，不需要在 CI 中安装 Office 或 Python 文档库。

| 文件 | 内容与来源 |
| --- | --- |
| sample.pdf / sample-alt.pdf | PyMuPDF 生成的一页文档，正文不同，用于同名不同内容测试 |
| sample.docx | python-docx 生成的段落，包含中文、连续空格和数学符号 |
| sample.pptx | python-pptx 生成的一页幻灯片 |
| sample.xlsx | openpyxl 生成的文本、数值与公式单元格 |
| sample.doc / sample.ppt / sample.xls | 使用本机 Microsoft Office 将上述文档另存为旧格式；移除文档个人信息 |
| sample.png / sample.jpg | Pillow 生成的 24 × 16 纯色图片 |

## 可选重新生成

在安装了 PyMuPDF、python-docx、python-pptx、openpyxl、Pillow 的环境中运行：

~~~sh
python tests/fixtures/downloads/generate.py
~~~

Windows 上可另外安装 pywin32，并在 **Word、PowerPoint、Excel 全部关闭**时运行：

~~~sh
python tests/fixtures/downloads/convert-office.py
~~~

转换脚本只创建自己的 Office 实例，不连接已打开的用户文档。文档元信息及 ZIP 时间戳可能因工具版本不同而改变；自动化测试比较当前源样本与下载文件的 SHA-256，不依赖固定二进制快照哈希。

样本不是“只带魔数的假文件”。本轮已用 PyMuPDF、python-docx、python-pptx、openpyxl、Pillow，以及 Microsoft Word／PowerPoint／Excel 独立打开并核对内容。
