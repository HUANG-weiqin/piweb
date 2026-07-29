# Context Compressor

独立、无状态的 TypeScript 行流压缩内核。

```ts
import { compressLineStream } from "@piweb/context-compressor";

const output = compressLineStream(input);
```

它只处理字符串：移除常见 ANSI CSI/OSC 控制序列、折叠连续重复行；折叠结果超过 8192 UTF-8 bytes 时，保留固定首尾窗口，以及包含 error、exception、failed、failure、fatal、panic、assert、warning、timeout、timed out、segmentation fault、segfault、access violation、out of memory、OOM 或 deadlock 的诊断行及其邻域，并确定性采样其余行。只有候选结果不超过原始 UTF-8 bytes 的 90% 才返回候选，否则精确返回输入。

该包不识别工具、会话、provider、Pi 格式、存储或 retrieval；没有 I/O、隐藏状态和 runtime dependency。调用方负责决定哪些文本适合压缩。
