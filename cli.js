#!/usr/local/bin/node

var dyngo= require('./index'),
    async= require('async'),
    fs= require('fs'),
    readline= require('readline'),
    _= require('underscore'),
    path= require('path').join,
    colors = require('colors');

var _history= [];
      
const getUserHome= function() 
      {
          return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
      },
      getHistory= function()
      {
          var historyFile= path(getUserHome(),'.dyngodb_history');

          if (fs.existsSync(historyFile))
            _history.push
            .apply(_history,JSON.parse(fs.readFileSync(historyFile,'utf8')));

          return _history;
      },
      saveHistory= function ()
      {
          var historyFile= path(getUserHome(),'.dyngodb_history');
        
          if (_history&&_history.length>0)
            fs.writeFileSync(historyFile,JSON.stringify(_history),'utf8');
      };

process.on('exit', saveHistory);
process.on('SIGINT', function () { saveHistory(); process.exit(0); });

dyngo(function (err,db)
{
   var rl = readline.createInterface
   ({
      input: process.stdin,
      output: process.stdout,
      completer: function (linePartial, cb)
      {
          if (linePartial.indexOf('db.')==0)
          {
            var tables= _.collect(_.filter(_.keys(db),
                                  function (key) { return key.indexOf(linePartial.replace('db.',''))==0; }),
                        function (res) { return 'db.'+res; });
            cb(null,[tables, linePartial]); 
          }
          else
            cb(null,[[], linePartial]); 
      }
   });

   var last;

   if (err)
     console.log(err);
   else
   {
     rl.history= getHistory();

     (function ask()
     {
         var _ask= function (fn)
             {
                 return function ()
                 {
                    var args= arguments;
                    fn.apply(null,args); 
                    ask();
                 };
             },
             _print= function (obj)
             {
                 last= obj;
                 console.log(JSON.stringify(db.cleanup(obj),null,2));
             };

         rl.question('> ', function (answer) 
         {

            if (!answer) { ask(); return; };
            
            if (answer.indexOf('show collections') > -1)
            { 
               _.filter(_.keys(db),function (key) { return !!db[key].find; }).forEach(function (c) { console.log(c); });
               ask();
               return;
            }

            try
            {
               var time= process.hrtime(),
                   promise= eval('(function (db,last){ return '+answer+'; })')(db,last),
                   elapsed= function ()
                   {
                      var diff= process.hrtime(time),
                          secs= (diff[0]*1e9+diff[1])/1e9;

                      console.log((secs+' secs').green);
                   };

               promise= promise || {};

               if (promise.error)
                 promise.error(_ask(function (err) 
                 { 
                     if (!err) return;

                     if (err.code=='notfound')
                       console.log('no data found'.yellow);
                     else
                       console.log((err+'').red,err.stack); 
                 }));

               if (promise.result)
                 promise.result(_ask(function (obj) { _print(obj); elapsed(); }));
               else
               if (promise.results)
                 promise.results(_ask(function (items) { _print(items); elapsed(); }));
               else
               if (promise.success)
                 promise.success(_ask(function () { console.log('done!'.green); elapsed(); }));
               else
                 _ask(function () { console.log(promise); })();
            }
            catch (ex)
            {
               console.log('unknown command'.red,ex,ex.stack);
               ask();
            }

            //rl.close();
         });
     })();
   }
});
