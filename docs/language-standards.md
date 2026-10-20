# language-standards.md · 语言规范标准

> **原则：本仓库不塞具体配置文件，只声明"对齐什么规范"。**
> Agent 初始化项目时，根据项目实际语言，**生成对应的 format/lint 配置**；CI 检测该规范。
> 生成配置后，把实际使用的工具版本与命令回填到 `docs/development.md`。

---

## 一、Go

- **格式化**：`gofmt`（官方内置，Go 语言强制标准）
- **Lint**：`golangci-lint`（社区事实标准，19k★）
- **测试**：`go test`（官方内置，`go test ./...`）
- **Agent 初始化**：
  ```bash
  gofmt -l .           # 检查未格式化文件
  golangci-lint run    # 跑 lint（自动检测配置，首次可 --init 生成 .golangci.yml）
  go test ./...        # 跑测试
  ```
- **CI 检查**：
  ```bash
  test -z "$(gofmt -l .)" && golangci-lint run && go test ./...
  ```

## 二、Rust

- **格式化**：`rustfmt`（官方组件，随 Rust 发布）
- **Lint**：`clippy`（官方组件，rust-lang 13k★）
- **测试**：`cargo test`（官方内置）
- **Agent 初始化**：
  ```bash
  cargo fmt            # 格式化
  cargo clippy         # lint（-D warnings 严格模式）
  cargo test           # 跑测试
  ```
- **CI 检查**：
  ```bash
  cargo fmt --check && cargo clippy -- -D warnings && cargo test
  ```

## 三、Python

- **格式化 + Lint**：`ruff`（现代 Python 事实标准，49k★，取代 flake8/black）
- **测试**：`pytest`（Python 事实标准测试框架）
- **Agent 初始化**：
  ```bash
  pip install ruff pytest
  ruff check .         # lint
  ruff format .        # format
  pytest               # 跑测试
  ```
- **CI 检查**：
  ```bash
  ruff check . && ruff format --check . && pytest
  ```

## 四、TypeScript / JavaScript

- **格式化**：`prettier`（52k★，跨语言最广泛格式化器）
- **Lint**：`oxlint`（oxc 生态 22k★）或 ESLint（传统默认）
- **测试**：`vitest`（现代 TS 事实标准，Vite 生态）或 jest（传统）
- **Agent 初始化**：
  ```bash
  npm i -D prettier oxlint vitest
  npx prettier --write .   # 格式化
  npx oxlint .             # lint（自动检测配置）
  npx vitest run           # 跑测试
  ```
- **CI 检查**：
  ```bash
  npx prettier --check . && npx oxlint . && npx vitest run
  ```

## 五、Java

- **Lint**：`checkstyle`（9k★，Java 历史最久、最广泛）
- **格式化**：`google-java-format`（Google 官方）或 Checkstyle 自带格式检查
- **测试**：`JUnit 5`（Java 事实标准测试框架）
- **Agent 初始化**：
  ```bash
  # Maven
  mvn checkstyle:check
  mvn test            # 跑 JUnit 测试
  # Gradle
  ./gradlew checkstyleMain
  ./gradlew test
  ```
- **CI 检查**：
  ```bash
  mvn checkstyle:check && mvn spotless:check && mvn test   # 若用 spotless 做格式
  ```

## 六、C++

- **格式化**：`clang-format`（LLVM 39.9k★，C++ 格式化事实标准）
- **Lint**：`clang-tidy`（LLVM 官方，静态分析）或 cpplint（Google 风格，1.8k★）
- **测试**：`GoogleTest`（C++ 事实标准测试框架，Google 官方）
- **Agent 初始化**：
  ```bash
  clang-format -i **/*.{cpp,h,hpp}   # 格式化（基于 .clang-format）
  clang-tidy **/*.cpp                # lint
  # GoogleTest：cmake --build build && ctest
  ```
- **CI 检查**：
  ```bash
  clang-format --dry-run --Werror **/*.{cpp,h,hpp} && clang-tidy **/*.cpp && ctest
  ```

---

## 规范选择原则

- **优先官方组件**（Go/Rust）：随语言发布，零争议
- **优先社区事实标准**（Python ruff、TS prettier、GoogleTest、JUnit）：星数最高、采用最广
- **C++/Java 无单一官方**：C++ 用 clang-format，Java 用 checkstyle + google-java-format
- **测试框架**：Go/Rust 官方内置，Python 用 pytest，TS 用 vitest，Java 用 JUnit，C++ 用 GoogleTest
- 若项目已有团队规范，**以团队规范为准**，本文件仅作默认
