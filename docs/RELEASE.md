# 发布流程（维护者）

发版走 GitHub Actions，用 npm 的 **Trusted Publishing（OIDC）**，不需要任何 token 或 secret。

## 一次性配置

只做一次。**首版必须手动发** —— npm 只能给已经存在的包配置 Trusted Publisher，包还不存在时设置页上没有这个入口。

### 1. 手动发 1.0.0

```bash
cd /path/to/dsh-opencode-go   # 本仓库
npm login                     # 浏览器授权 + 2FA
npm whoami                    # 确认登录成功
npm publish --access public
```

### 2. 配置 Trusted Publisher

打开 `https://www.npmjs.com/package/dsh-opencode-go-plus` → **Settings** → **Trusted Publisher** → **GitHub Actions**：

| 字段 | 值 |
| --- | --- |
| Organization or user | `yumusb` |
| Repository | `dsh-opencode-go-plus` |
| Workflow filename | `npm-publish.yml` |
| Allowed actions | Allow `npm publish` |

保存后就不需要再管了。

## 日常发版

```bash
./scripts/release.sh          # patch：1.0.0 → 1.0.1
./scripts/release.sh minor    # minor：1.0.0 → 1.1.0
./scripts/release.sh major    # major：1.0.0 → 2.0.0
```

脚本依次做：跑测试 → 升 `package.json` 版本 → 提交 → 打 `vX.Y.Z` tag → 推送。tag 推上去后 `.github/workflows/npm-publish.yml` 自动发布。

工作流有两道防呆：

- tag 和 `package.json` 版本不一致时直接失败
- 该版本已经发布过时跳过（所以给 1.0.0 补打 tag 不会红叉）

## 手动兜底

CI 不可用时：

```bash
npm publish --access public
```

## 为什么不用 NPM_TOKEN

npm 在 2025 年 12 月吊销了全部 classic token 并永久关闭了它的生成入口；granular token 的写权限默认只有 7 天，最长 90 天。也就是说 secret 方案需要定期轮换，不换就会在某天突然发不出去。

OIDC 没有任何长期凭据：GitHub 给工作流签发一个临时身份，npm 校验「确实是这个仓库的这条工作流」，然后签发短时凭据。顺带还会自动生成 provenance 签名证明。
