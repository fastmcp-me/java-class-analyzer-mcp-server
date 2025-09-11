#!/usr/bin/env node

// 直接测试MCP工具，不通过MCP客户端
import { DependencyScanner } from './dist/scanner/DependencyScanner.js';
import { DecompilerService } from './dist/decompiler/DecompilerService.js';
import { JavaClassAnalyzer } from './dist/analyzer/JavaClassAnalyzer.js';

// 解析命令行参数
function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        tool: 'all', // 默认测试所有工具
        projectPath: 'd:\\my-project',
        className: 'com.alibaba.excel.EasyExcelFactory',
        forceRefresh: true,
        useCache: true, // 默认使用缓存
        cfrPath: undefined // CFR路径，可选
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '--tool':
            case '-t':
                config.tool = args[++i];
                break;
            case '--project':
            case '-p':
                config.projectPath = args[++i];
                break;
            case '--class':
            case '-c':
                config.className = args[++i];
                break;
            case '--no-refresh':
                config.forceRefresh = false;
                break;
            case '--no-cache':
                config.useCache = false;
                break;
            case '--cfr-path':
                config.cfrPath = args[++i];
                break;
            case '--help':
            case '-h':
                showHelp();
                process.exit(0);
                break;
        }
    }

    return config;
}

function showHelp() {
    console.log(`
用法: node test-tools.js [选项]

选项:
  -t, --tool <工具名>        指定要测试的工具 (scan|decompile|analyze|all)
  -p, --project <路径>       项目路径 (默认: d:\\my-project)
  -c, --class <类名>         要分析的类名 (默认: com.alibaba.excel.EasyExcelFactory)
  --no-refresh              不强制刷新依赖索引
  --no-cache                不使用反编译缓存
  --cfr-path <路径>         指定CFR反编译工具的jar包路径
  --include-deps            包含依赖分析
  -h, --help                显示帮助信息

示例:
  node test-tools.js                                    # 测试所有工具
  node test-tools.js -t scan -p /path/to/project       # 只测试依赖扫描
  node test-tools.js -t decompile -c java.lang.String  # 只测试反编译
  node test-tools.js -t analyze --include-deps         # 测试类分析并包含依赖
`);
}

async function testScanDependencies(config) {
    console.log('=== 测试依赖扫描 ===');
    console.log(`项目路径: ${config.projectPath}`);
    console.log(`强制刷新: ${config.forceRefresh}\n`);

    const scanner = new DependencyScanner();
    const scanResult = await scanner.scanProject(config.projectPath, config.forceRefresh);

    console.log('扫描结果:', {
        jarCount: scanResult.jarCount,
        classCount: scanResult.classCount,
        indexPath: scanResult.indexPath
    });
    console.log('示例条目:', scanResult.sampleEntries.slice(0, 3));
    console.log('✅ 依赖扫描完成\n');

    return scanResult;
}

async function testDecompileClass(config) {
    console.log('=== 测试类反编译 ===');
    console.log(`类名: ${config.className}`);
    console.log(`项目路径: ${config.projectPath}`);
    console.log(`使用缓存: ${config.useCache !== false}`);
    console.log(`CFR路径: ${config.cfrPath || '自动查找'}\n`);

    const decompiler = new DecompilerService();
    const sourceCode = await decompiler.decompileClass(config.className, config.projectPath, config.useCache !== false, config.cfrPath);

    console.log('反编译结果长度:', sourceCode.length);
    console.log('源码预览:', sourceCode.substring(0, 200) + '...');
    console.log('✅ 反编译完成\n');

    return sourceCode;
}

async function testAnalyzeClass(config) {
    console.log('=== 测试类分析 ===');
    console.log(`类名: ${config.className}`);
    console.log(`项目路径: ${config.projectPath}`);

    const analyzer = new JavaClassAnalyzer();
    const analysis = await analyzer.analyzeClass(config.className, config.projectPath);

    console.log('类分析结果:', {
        className: analysis.className,
        packageName: analysis.packageName,
        modifiers: analysis.modifiers,
        fields: analysis.fields.length,
        methods: analysis.methods.length
    });

    if (analysis.methods.length > 0) {
        console.log('\n方法列表:');
        analysis.methods.forEach((method, index) => {
            console.log(`${index + 1}. ${method.modifiers.join(' ')} ${method.returnType} ${method.name}(${method.parameters.join(', ')})`);
        });
    }

    if (analysis.fields.length > 0) {
        console.log('\n字段列表:');
        analysis.fields.forEach((field, index) => {
            console.log(`${index + 1}. ${field.modifiers.join(' ')} ${field.type} ${field.name}`);
        });
    }

    console.log('✅ 类分析完成\n');

    return analysis;
}

async function testClassLookup(config) {
    console.log('=== 测试类查找 ===');
    console.log(`类名: ${config.className}`);
    console.log(`项目路径: ${config.projectPath}\n`);

    const scanner = new DependencyScanner();
    const jarPath = await scanner.findJarForClass(config.className, config.projectPath);

    console.log(`类 ${config.className} 对应的JAR包:`, jarPath);
    console.log('✅ 类查找完成\n');

    return jarPath;
}

async function testTools() {
    const config = parseArgs();

    console.log('=== 直接测试MCP工具 ===');
    console.log('配置:', config);
    console.log('');

    try {
        switch (config.tool) {
            case 'scan':
                await testScanDependencies(config);
                break;
            case 'decompile':
                await testDecompileClass(config);
                break;
            case 'analyze':
                await testAnalyzeClass(config);
                break;
            case 'lookup':
                await testClassLookup(config);
                break;
            case 'all':
            default:
                // 按顺序测试所有工具
                await testScanDependencies(config);
                await testClassLookup(config);
                await testDecompileClass(config);
                await testAnalyzeClass(config);
                console.log('🎉 所有测试通过！');
                break;
        }

    } catch (error) {
        console.error('❌ 测试失败:', error.message);
        console.error('错误详情:', error);
        process.exit(1);
    }
}

testTools();
