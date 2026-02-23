---
title: ES源码分析三、节点在启动时发生了什么？
date: 2021-09-01 00:25:25
tags: Elasticsearch源码分析&实战
---

## 3.1 ES节点启动流程做了什么？
1. 解析配置：配置文件和命令行参数
2. 检测外部/内部环境：JVM版本，操作系统内核参数等
3. 初始化内部资源：创建内部模块，初始化探测器
4. 启动：各个子模块和keepalive线程启动

## 3.2 启动流程分析
### 3.2.1 启动脚本解析
通过 bin/elasticsearch启动ES时，启动脚本通过exec加载Java程序。
```
exec \   #执行命令
	"$JAVA" \  #Java执行路径
	$ES_JAVA_OPTS \ #JVM选项
	-Des.path.home="$ES_HOME" \ #设置path.home路径
	-Des.path.conf="$ES_PATH_CONF" \ #设置 java classpath
  -cp "$ES_CLASSPATH" \ #设置java classpath
 	org.elasticsearch.bootstrap.Elasticsearch \ #指定main函数所在类
	"$@" #传递给main函数的命令行参数
```

### 3.2.2 命令行参数和配置文件解析
ES_JAVA_OPTS 保存了JVM参数，例如：
* -E 设置某项配置，比如设置集群名称： -E "cluster.name=my_cluster"， 一般通过配置文件设置。
* -V 打印版本号信息
* -d 后台启动
* -h 打印帮助信息
* -p 启动时在指定路径创建一个pid文件，其中保存了当前进程的pid，
* -q 关闭控制台的标准输入和标准错误输出
* -s 终端输出最少信息
* -v 终端输出详细信息

此处解析的配置文件有两个：elasticsearch.yml  主要配置文件；log4j2.properties  日志配置文件

::jvm.options::是在启动脚本中解析的。

### 3.2.3 加载安全配置
ES一般会将配置文件中的某些配置信息加密存放，放置位置在config/elasticsearch.keystore中。
比如X-Pack中的security相关配置、LDAP的base_dn等信息。

### 3.2.4 检查内部环境
* Lucene版本检查：ES各版本对应Lucene版本是有要求的。
* Jar包冲突检查：JarHell jar地狱
以上检查失败直接退出进程

### 3.2.5 检测外部环境
ES中的节点被封装为“node”模块，在node类中调用其他内部组件，同时对外提供启动和关闭方法，对外部环境的检测是在Node.start()中进行的。
~外部环境一般指：运行时JVM、操作系统等相关参数，被称为“Bootstrap Check”。~
~早期的ES版本中，ES检测到一些不合理的配置会记录到日志中继续运行。但是有时候用户会错过这些日志。为了避免 后期才发现问题，ES在启动阶段对那些很重要的参数做检查，一些影响 性能的配置会被标记为错误。~

* 堆大小检查
检测JVM初始堆大小(Xms)与最大堆大小(Xmx)的值应设置为相同值。
* 文件描述符检查
UNIX架构的系统中，“文件”可以是普通的物理文件，也可以是虚 拟文件，网络套接字也是文件描述符。ES进程需要非常多的文件描述符。例如，每个分片有很多段，每个段都有很多文件。同时包括许多与 其他节点的网络连接等。
要通过此项检查，就需要调整系统的默认配置
* 内存锁定检查
ES允许进程只使用物理内存，避免使用交换分区。
* 最大线程数检查
确保ES进程有创建 足够多线程的权限。
* 最大虚拟内存检查
Lucene使用mmap来映射部分索引到进程地址空间，最大虚拟内存检查确保ES进程拥有足够多的地址空间。
* 最大文件大小检查
段文件和事务日志文件可能特别大，官方建议最大文件大小设置为无限。
* 虚拟内存区域最大数量检查
ES进程需要创建很多内存映射区，本项检查是要确保内核允许创建 至少262144个内存映射区。
sysctl -w vm.max_map_count=262144 
* JVM Client模式检查
client JVM模式与server JVM模式。
client JVM调优了启动时间和内存消耗，server JVM提供了更高的性能。要想通过此检查，需要以server的方式来启动ES
* 串行收集检查
串行收集器适合比较小的堆或者单CPU的机器，不适合ES，ES启动默认使用CMS垃圾收集器。
* 系统调用过滤器检查
* OnError与OnOutOfMemoryError检查
* Early-access检查
* G1GC检查

### 3.2.6 启动内部模块
环境监测完毕后开始启动各个子模块，子模块在Node类中创建，启动他们时调用各自的start()方法。
discovery.start();
clusterService.start();
nodeConnectionsService.start(); 
……
~子模块的start方法基本就是初始化内部数据、创建线程池、启动线程池等操作。~

### 3.2.7 启动keepalive线程
~调用keepAliveThread.start()方法启动keepalive线程，线程本身不 做具体的工作。主线程执行完启动流程后会退出，keepalive线程是唯一 的用户线程，作用是保持进程运行。在Java程序中，至少要有一个用户 线程。当用户线程数为零时退出进程。~

## 3.3 节点关闭流程













