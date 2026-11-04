/** Pure presentation: no filesystem, network, or application access. */
export function formatData(rows:Record<string,unknown>[],format:'json'|'csv'|'markdown'):string {
  if(format==='json')return JSON.stringify(rows,null,2);
  const columns=['id','name','project','status','due','defer','note'];
  const value=(row:Record<string,unknown>,key:string)=>String(row[key]??'');
  if(format==='csv'){
    // Quoting alone does not stop spreadsheet formula execution.
    const cell=(s:string)=>'"'+(/^[=+@\-\t\r]/.test(s)?"'"+s:s).replaceAll('"','""')+'"';
    return [columns.map(cell).join(','),...rows.map(row=>columns.map(k=>cell(value(row,k))).join(','))].join('\r\n');
  }
  const cell=(s:string)=>s.replaceAll('\\','\\\\').replaceAll('|','\\|').replace(/\r?\n/g,'<br>');
  return ['| '+columns.join(' | ')+' |','| '+columns.map(()=>'---').join(' | ')+' |',...rows.map(row=>'| '+columns.map(k=>cell(value(row,k))).join(' | ')+' |')].join('\n');
}
