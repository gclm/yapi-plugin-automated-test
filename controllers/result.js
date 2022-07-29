const openController = require('controllers/open.js');
const projectModel = require('models/project.js');
const testResultModel = require('./../models/result');
const testPlanModel = require('./../models/plan');
const yapi = require('yapi.js');
const _ = require('underscore');
const renderToHtml = require('../../../server/utils/reportHtml');
const axios = require("axios");
const ChatBot = require('dingtalk-robot-sender');
const markdown = require('../utils/markdown');

class testResultController extends openController {
    constructor(ctx) {
        super(ctx);

        this.testResultModel = yapi.getInst(testResultModel);
        this.testPlanModel = yapi.getInst(testPlanModel);
        this.projectModel = yapi.getInst(projectModel);

        this.schemaMap = {
            runAutoTest: {
                '*id': 'number', extraIds: 'string', project_id: 'string', token: 'string', mode: {
                    type: 'string', default: 'json'
                }, email: {
                    type: 'boolean', default: false
                }, download: {
                    type: 'boolean', default: false
                }, closeRemoveAdditional: true
            }
        };

    }

    /**
     * 获取项目下的测试结果
     * @param {*} ctx
     */
    async getTestResults(ctx) {
        try {
            const projectId = ctx.params.project_id;
            const planId = ctx.params.plan_id;
            let results;
            if (projectId) {
                results = await this.testResultModel.findByProject(projectId)
            }
            if (planId) {
                results = await this.testResultModel.findByPlan(planId)
            }
            ctx.body = yapi.commons.resReturn(results);
        } catch (e) {
            ctx.body = yapi.commons.resReturn(null, 401, e.message);
        }
    }

    /**
     * 获取测试结果
     * @param {*} ctx
     */
    async getTestResult(ctx) {
        if (!this.$tokenAuth && !this.$auth) {
            return (ctx.body = yapi.commons.resReturn(null, 40022, 'token 验证失败'));
        }
        try {
            const id = ctx.params.id;
            let results = await this.testResultModel.get(id)
            ctx.body = renderToHtml(results.data);
        } catch (e) {
            ctx.body = yapi.commons.resReturn(null, 401, e.message);
        }
    }

    /**
     * 清空测试结果
     * @param {*} ctx
     */
    async delTestResults(ctx) {
        try {
            const plan_id = ctx.params.plan_id;

            if ((await this.checkAuth(ctx.params.project_id, 'project', 'edit')) !== true) {
                return (ctx.body = yapi.commons.resReturn(null, 405, '没有权限删除'));
            }

            let result = await this.testResultModel.deleteAll(plan_id);
            ctx.body = yapi.commons.resReturn(result);
        } catch (e) {
            ctx.body = yapi.commons.resReturn(null, 401, e.message);
        }
    }

    /**
     * 执行测试计划
     * @param {*} ctx
     */
    async runAutoTest(ctx) {
        if (!this.$tokenAuth) {
            return (ctx.body = yapi.commons.resReturn(null, 40022, 'token 验证失败'));
        }

        const projectId = ctx.params.project_id;
        const planId = ctx.params.plan_id;
        const id = ctx.params.id;
        let autoTestUrl = ctx.href;
        autoTestUrl = autoTestUrl.replace("download=true", "download=false")
                                 .replace("mode=html", "mode=json")
                                 .replace("/api/open/plugin/test/run","/api/open/run_auto_test");
        let urlObj = new URL(autoTestUrl);
        let project = await this.projectModel.get(projectId);
        let colObj = await this.interfaceColModel.get(id);
        if (!colObj) {
            return (ctx.body = yapi.commons.resReturn(null, 40022, 'id值不存在'));
        }

        /**
         * 数据处理
         * 1. 根据planId 获取plan
         * 2. 基于plan获取自动测试url，并发送自动化测试请求
         * 3. 判断是否要发送通知
         * 4. 保存记录
         */
        if (planId) {
            await this.testPlanModel.update(planId, {last_test_time: yapi.commons.time()});
            let plan = await this.testPlanModel.find(planId);
            let curEnvList = this.handleEvnParams(ctx.params);

            let result = await axios.get(autoTestUrl);
            if (result.status === 200) {
                result = result.data;
                yapi.commons.log(`${yapi.commons.time()} --> 定时器触发：项目【${project.name}】下测试计划【${plan.plan_name}】--> 【${autoTestUrl}】`);

                let testData = {
                    project_id: projectId,
                    plan_id: planId,
                    uid: this.getUid(),
                    col_names: colObj.name,
                    env: curEnvList,
                    test_url: ctx.href,
                    status: result.message.failedNum === 0 ? "成功" : "失败",
                    data: result
                };
                let saveResult = await this.testResultModel.save(testData);
                let testResultUrl = `${urlObj.origin}/api/open/plugin/test/result?id=${saveResult._id}`;
                let env = this.getEnvName(urlObj.searchParams);
                let testCollection = colObj.name;


                let triggers = plan.notice_triggers || [plan.notice_trigger],
                    notifier = plan.notifier ? plan.notifier : "";
                let successNum = result.message.successNum, failedNum = result.message.failedNum;
                // 是否发送通知
                let isSend = (triggers.includes("any")) // 任何情况下都发送
                    || (triggers.includes("success") && failedNum === 0) // 成功才发送
                    || (triggers.includes("fail") && successNum === 0) // 失败才发送
                    || (triggers.includes("part") && successNum < result.message.len && successNum > 0); // 部分成功才发送
                if (isSend && notifier) {
                    this.sendMarkdownNotifier(notifier.url, notifier.secret, project, env, testCollection, result, testResultUrl);
                }

                if (ctx.params.email === true) {
                    this.sendEmailNotifier(env, testCollection, result, testResultUrl)
                }
                let mode = ctx.params.mode || 'html';
                if (ctx.params.download === true) {
                    ctx.set('Content-Disposition', `attachment; filename=test.${mode}`);
                }

                if (ctx.params.mode === 'json') {
                    return (ctx.body = result);
                } else {
                    return (ctx.body = renderToHtml(result));
                }
            } else {
                console.log(`获取自动化测试结果异常: ${result.status} --> ${result.data}`)
            }
        } else {
            console.log("发生异常")
        }
    }

    async sendEmailNotifier(env, testCollection, data, testResultUrl) {
        yapi.commons.sendNotice(projectId, {
            title: `YApi自动化测试报告`, content: `
          <html>
          <head>
          <title>测试报告</title>
          <meta charset="utf-8" />
          <body>
          <div>
          <h3>测试结果：</h3>
          <p>${result.message.msg}</p>
          <h3>测试环境：</h3>
          <p>${env}</p>
          <h3>测试集合：</h3>
          <p>${testCollection}</p>
          <h3>访问以下链接查看测试结果详情：</h3>
          <p><a herf="${testResultUrl}">${testResultUrl}</a></p>
          </div>
          </body>
          </html>`
        });
    }

    async sendMarkdownNotifier(url, secret, project, env, testCollection, data, testResultUrl) {
        if (!data) {
            return
        }
        const title = await this.buildTitle(project, data);
        const text = await this.buildText(project, data, title, env, testResultUrl, testCollection);

        console.log("title:", title, " --> text:", text)

        const robot = new ChatBot({
            baseUrl: 'https://oapi.dingtalk.com/robot/send',
            accessToken: url.replace("https://oapi.dingtalk.com/robot/send?access_token=", ""),
            secret: secret
        });
        await robot.markdown(title, text, {})
    }

    async buildTitle(project, data) {
        const name = project ? project.name : '有个项目';
        let pieces = [name];
        const result = data.message.failedNum === 0 ? ':自动测试全部通过' : ':有测试用例失败';
        pieces.push(result);
        return pieces.join('');
    }

    async buildText(project, data, title, env, testResultUrl, testCollection) {
        let result = data.message.msg;
        let failedNum = data.message.failedNum;
        let pieces = [
            `## ${title} \n`,
            `### 测试计划  \n`,
            `- 项目：${project.name} \n`,
            `- 环境：${env} \n`,
            `- 结果：${result} \n`,
            `- 详情：[${testCollection}](${testResultUrl}) \n\n`,
        ]
        if (failedNum !== 0) {
            pieces.push(`### 失败接口 \n`)
            let failedList = data.list.filter(item => item.code !== 0)
            for (let i = 0; i < failedList.length; i++) {
                let item = failedList[i]
                pieces.push(`- <font color="#ff4757"> 【${item.name}】 --> ${item.path} </font> \n`)
            }
            pieces.push("\n\n ![有测试用例失败](https://dev.coderlab.cn/gitfox/fail.jpeg) \n")
        } else {
            pieces.push("\n\n ![全部通过](https://dev.coderlab.cn/gitfox/ok.jpeg) \n")
        }
        return pieces.join('')
    }

    red(text) {
        return '<span style="color: red">' + text + '</span>'
    }

    showList(test) {
        return '<li>' + test + '</li>'
    }

    getEnvName(searchParams) {
        let envName = "默认"
        searchParams.forEach((value, name) => {
            if (!name.search("env")) {
                envName = value
            }
        });
        return envName
    }

}

module.exports = testResultController;