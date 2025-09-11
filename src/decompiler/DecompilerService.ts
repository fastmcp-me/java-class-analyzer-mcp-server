import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import { readFile, readdir } from 'fs/promises';
import * as path from 'path';
import * as yauzl from 'yauzl';
import { fileURLToPath } from 'url';
import { createWriteStream } from 'fs';
import { DependencyScanner } from '../scanner/DependencyScanner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

export class DecompilerService {
    private scanner: DependencyScanner;
    private cfrPath: string;

    constructor() {
        this.scanner = new DependencyScanner();
        this.cfrPath = '';
    }

    private async initializeCfrPath(): Promise<void> {
        if (!this.cfrPath) {
            this.cfrPath = await this.findCfrJar();
            if (!this.cfrPath) {
                throw new Error('未找到CFR反编译工具。请下载CFR jar包到lib目录或设置CFR_PATH环境变量');
            }
            console.error(`CFR工具路径: ${this.cfrPath}`);
        }
    }

    /**
     * 反编译指定的Java类文件
     */
    async decompileClass(className: string, projectPath: string, useCache: boolean = true, cfrPath?: string): Promise<string> {
        try {
            // 如果外部指定了CFR路径，则使用外部路径
            if (cfrPath) {
                this.cfrPath = cfrPath;
                console.error(`使用外部指定的CFR工具路径: ${this.cfrPath}`);
            } else {
                await this.initializeCfrPath();
            }

            // 1. 检查缓存
            const cachePath = this.getCachePath(className, projectPath);
            if (useCache && await fs.pathExists(cachePath)) {
                console.error(`使用缓存的反编译结果: ${cachePath}`);
                return await readFile(cachePath, 'utf-8');
            }

            // 2. 查找类对应的JAR包
            console.error(`查找类 ${className} 对应的JAR包...`);

            // 添加超时处理
            const jarPath = await Promise.race([
                this.scanner.findJarForClass(className, projectPath),
                new Promise<null>((_, reject) =>
                    setTimeout(() => reject(new Error('查找JAR包超时')), 10000)
                )
            ]);

            if (!jarPath) {
                throw new Error(`未找到类 ${className} 对应的JAR包，请先运行 scan_dependencies 建立类索引`);
            }
            console.error(`找到JAR包: ${jarPath}`);

            // 3. 从JAR包中提取.class文件
            const classFilePath = await this.extractClassFile(jarPath, className);

            // 4. 使用CFR反编译
            const sourceCode = await this.decompileWithCfr(classFilePath);

            // 5. 保存到缓存
            if (useCache) {
                await fs.ensureDir(path.dirname(cachePath));
                await fs.outputFile(cachePath, sourceCode, 'utf-8');
                console.error(`反编译结果已缓存: ${cachePath}`);
            }

            // 6. 清理临时文件（只有在不使用缓存时才清理）
            if (!useCache) {
                try {
                    await fs.remove(classFilePath);
                    console.error(`清理临时文件: ${classFilePath}`);
                } catch (cleanupError) {
                    console.warn(`清理临时文件失败: ${cleanupError}`);
                }
            }

            return sourceCode;
        } catch (error) {
            console.error(`反编译类 ${className} 失败:`, error);
            throw error; // 重新抛出错误，让上层处理
        }
    }

    /**
     * 获取缓存文件路径
     */
    private getCachePath(className: string, projectPath: string): string {
        const packagePath = className.substring(0, className.lastIndexOf('.'));
        const simpleName = className.substring(className.lastIndexOf('.') + 1);
        const cacheDir = path.join(projectPath, '.mcp-decompile-cache');
        const packageDir = path.join(cacheDir, packagePath.replace(/\./g, path.sep));
        return path.join(packageDir, `${simpleName}.java`);
    }

    /**
     * 从JAR包中提取指定的.class文件
     */
    private async extractClassFile(jarPath: string, className: string): Promise<string> {
        const classFileName = className.replace(/\./g, '/') + '.class';
        const tempDir = path.join(process.cwd(), '.mcp-class-temp');
        // 按包名全路径创建目录结构
        const packagePath = className.substring(0, className.lastIndexOf('.'));
        const packageDir = path.join(tempDir, packagePath.replace(/\./g, path.sep));
        const classFilePath = path.join(packageDir, `${className.substring(className.lastIndexOf('.') + 1)}.class`);

        await fs.ensureDir(packageDir);

        console.error(`从JAR包提取类文件: ${jarPath} -> ${classFileName}`);

        return new Promise((resolve, reject) => {
            yauzl.open(jarPath, { lazyEntries: true }, (err: any, zipfile: any) => {
                if (err) {
                    reject(new Error(`无法打开JAR包 ${jarPath}: ${err.message}`));
                    return;
                }

                let found = false;
                zipfile.readEntry();

                zipfile.on('entry', (entry: any) => {
                    if (entry.fileName === classFileName) {
                        found = true;
                        zipfile.openReadStream(entry, (err: any, readStream: any) => {
                            if (err) {
                                reject(new Error(`无法读取JAR包中的类文件 ${classFileName}: ${err.message}`));
                                return;
                            }

                            const writeStream = createWriteStream(classFilePath);
                            readStream.pipe(writeStream);

                            writeStream.on('close', () => {
                                console.error(`类文件提取成功: ${classFilePath}`);
                                resolve(classFilePath);
                            });

                            writeStream.on('error', (err: any) => {
                                reject(new Error(`写入临时文件失败: ${err.message}`));
                            });
                        });
                    } else {
                        zipfile.readEntry();
                    }
                });

                zipfile.on('end', () => {
                    if (!found) {
                        reject(new Error(`在JAR包 ${jarPath} 中未找到类文件: ${classFileName}`));
                    }
                });

                zipfile.on('error', (err: any) => {
                    reject(new Error(`读取JAR包失败: ${err.message}`));
                });
            });
        });
    }

    /**
     * 使用CFR反编译.class文件
     */
    private async decompileWithCfr(classFilePath: string): Promise<string> {
        if (!this.cfrPath) {
            throw new Error('未找到CFR反编译工具，请确保CFR jar包在classpath中');
        }

        try {
            const javaCmd = this.getJavaCommand();
            // 如果Java路径包含空格，需要用引号包围
            const quotedJavaCmd = javaCmd.includes(' ') ? `"${javaCmd}"` : javaCmd;
            console.error(`执行CFR反编译: ${quotedJavaCmd} -jar "${this.cfrPath}" "${classFilePath}"`);

            const { stdout, stderr } = await execAsync(

                `${quotedJavaCmd} -jar "${this.cfrPath}" "${classFilePath}" --silent true`,
                { timeout: 30000 }
            );

            if (stderr && stderr.trim()) {
                console.warn('CFR警告:', stderr);
            }

            if (!stdout || stdout.trim() === '') {
                throw new Error('CFR反编译返回空结果，可能是类文件损坏或CFR版本不兼容');
            }

            return stdout;
        } catch (error) {
            console.error('CFR反编译执行失败:', error);
            if (error instanceof Error && error.message.includes('timeout')) {
                throw new Error('CFR反编译超时，请检查Java环境和CFR工具');
            }
            throw new Error(`CFR反编译失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 查找CFR jar包路径
     */
    private async findCfrJar(): Promise<string> {
        // 尝试从多个可能的位置查找CFR
        const searchPaths = [
            path.join(process.cwd(), 'lib'),
            process.cwd(),
            path.join(__dirname, '..', '..', 'lib'),
            path.join(__dirname, '..', '..'),
        ];

        for (const searchPath of searchPaths) {
            if (await fs.pathExists(searchPath)) {
                const files = await readdir(searchPath);
                const cfrJar = files.find(file => /^cfr-.*\.jar$/.test(file));
                if (cfrJar) {
                    return path.join(searchPath, cfrJar);
                }
            }
        }

        // 如果没找到，尝试从classpath中查找
        const classpath = process.env.CLASSPATH || '';
        const classpathEntries = classpath.split(path.delimiter);

        for (const entry of classpathEntries) {
            if (entry.includes('cfr') && entry.endsWith('.jar')) {
                return entry;
            }
        }

        return '';
    }

    /**
     * 批量反编译多个类
     */
    async decompileClasses(classNames: string[], projectPath: string, useCache: boolean = true, cfrPath?: string): Promise<Map<string, string>> {
        const results = new Map<string, string>();

        for (const className of classNames) {
            try {
                const sourceCode = await this.decompileClass(className, projectPath, useCache, cfrPath);
                results.set(className, sourceCode);
            } catch (error) {
                console.warn(`反编译类 ${className} 失败: ${error}`);
                results.set(className, `// 反编译失败: ${error}`);
            }
        }

        return results;
    }


    /**
     * 获取Java命令路径
     */
    private getJavaCommand(): string {
        const javaHome = process.env.JAVA_HOME;
        if (javaHome) {
            const javaCmd = process.platform === 'win32' ? 'java.exe' : 'java';
            return path.join(javaHome, 'bin', javaCmd);
        }
        return 'java'; // 回退到PATH中的java
    }
}
